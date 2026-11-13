import { Router } from "express";
import { createAuthController } from "../controllers/auth.controller.js";
import { createAuthService } from "../services/auth.service.js";
import { createSessionService } from "../services/session.service.js";
import { createMfaService } from "../services/mfa.service.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { createRecentMfaMiddleware } from "../middleware/recentMfa.middleware.js";
import { createStepUpAuthorizationMiddleware } from "../middleware/recentMfa.middleware.js";
import { DEFAULT_STEP_UP_PURPOSES } from "../services/step-up-purpose.registry.js";
import { createAuthLoginRateLimiter, createAuthSessionRateLimiter, createMfaChallengeRateLimiter, createMfaStepUpRateLimiter, createMfaVerificationRateLimiter, createRecoveryMutationRateLimiter, createRegistrationRateLimiter } from "../middleware/rateLimit.middleware.js";
import { getEnv } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { z } from "zod";
import { mfaEnrollmentSchema, recoveryApprovalSchema, recoveryIdentityReferenceSchema } from "../validators/mfa.validator.js";
import { validateRequest } from "../middleware/validate.middleware.js";

export const createAuthRouter = (dependencies = {}) => {
  const sessionService = dependencies.sessionService ?? createSessionService();
  const mfaService = dependencies.mfaService ?? createMfaService({ ...(dependencies.environment ? { environment: dependencies.environment } : {}), ...(dependencies.mfaEncryptionProvider ? { encryptionProvider: dependencies.mfaEncryptionProvider } : {}), ...(dependencies.stepUpPurposes ? { stepUpPurposes: dependencies.stepUpPurposes } : {}), ...(dependencies.verifyIndependentIdentity ? { verifyIndependentIdentity: dependencies.verifyIndependentIdentity } : {}), ...(dependencies.deliverLegacyAdminEnrollmentAuthorization ? { deliverLegacyAdminEnrollmentAuthorization: dependencies.deliverLegacyAdminEnrollmentAuthorization } : {}) });
  const authService = dependencies.authService ?? createAuthService({ sessionService, mfaService });
  const authenticationMiddleware = dependencies.authenticationMiddleware ?? requireAuthentication;
  const runtimeConfig = dependencies.environment ?? getEnv();
  const sharedRateLimitStore = dependencies.rateLimitStore;
  const rateLimitKeySecret = runtimeConfig.rateLimit.keySecret;
  const rateLimitConfig = runtimeConfig.mfa.verificationRateLimit;
  const sharedOptions = (settings, operation) => ({ ...settings, store: sharedRateLimitStore, keySecret: rateLimitKeySecret, operation });
  const mfaVerificationRateLimiter = dependencies.mfaVerificationRateLimiter ?? createMfaVerificationRateLimiter(sharedOptions(rateLimitConfig, "mfa-enrollment-verify"));
  const loginRateLimiter = dependencies.authLoginRateLimiter ?? createAuthLoginRateLimiter(sharedOptions(runtimeConfig.mfa.loginRateLimit, "login"));
  const sessionRateLimiter = createAuthSessionRateLimiter(sharedOptions(runtimeConfig.mfa.loginRateLimit, "session-token-operation"));
  const registrationRateLimiter = dependencies.authRegistrationRateLimiter ?? createRegistrationRateLimiter(sharedOptions(runtimeConfig.mfa.loginRateLimit, "registration"));
  const mfaEnrollmentRateLimiter = createRecoveryMutationRateLimiter(sharedOptions(rateLimitConfig, "mfa-enrollment-initiation"));
  const challengeRateLimiter = dependencies.mfaChallengeRateLimiter ?? createMfaChallengeRateLimiter(sharedOptions(runtimeConfig.mfa.challengeRateLimit, "mfa-login-challenge"));
  const stepUpCreateRateLimiter = dependencies.mfaStepUpCreateRateLimiter ?? createMfaStepUpRateLimiter(sharedOptions(runtimeConfig.mfa.challengeRateLimit, "mfa-step-up-create"));
  const stepUpVerifyRateLimiter = dependencies.mfaStepUpVerifyRateLimiter ?? createMfaStepUpRateLimiter(sharedOptions(runtimeConfig.mfa.challengeRateLimit, "mfa-step-up-verify"));
  const recoveryMutationLimiter = dependencies.mfaRecoveryMutationRateLimiter ?? createRecoveryMutationRateLimiter(sharedOptions(rateLimitConfig, "mfa-recovery-governance"));
  const createStepUpMiddleware = dependencies.stepUpAuthorizationMiddlewareFactory ?? createStepUpAuthorizationMiddleware;
  const legacyAdminRequestParamsSchema = z.object({ requestId: z.string().uuid() }).strict();
  const validateLegacyAdminRequest = (bodySchema) => (request, _response, next) => {
    if (!legacyAdminRequestParamsSchema.safeParse(request.params).success || !bodySchema.safeParse(request.body ?? {}).success) {
      return next(new ApiError(400, "VALIDATION_ERROR", "Request validation failed"));
    }
    return next();
  };
  const validateEmptyMfaBody = validateRequest({ body: mfaEnrollmentSchema });
  // Match the established ADMIN recent-TOTP window used by other admin read
  // routes. request.auth is populated by the server authentication middleware.
  const requireAdminRecentTotp = createRecentMfaMiddleware({ maxAgeSeconds: 300 });
  const router = Router();
  const controller = createAuthController({ authService, sessionService, mfaService });

  router.post("/register", registrationRateLimiter, controller.register);
  router.post("/login", loginRateLimiter, controller.login);
  router.post("/mfa/challenge/verify", challengeRateLimiter, controller.verifyMfaLogin);
  router.post("/refresh", sessionRateLimiter, controller.refresh);
  router.post("/logout", sessionRateLimiter, controller.logout);
  router.post("/logout-all", authenticationMiddleware, sessionRateLimiter, controller.logoutAll);
  router.post("/mfa/enroll", authenticationMiddleware, mfaEnrollmentRateLimiter, controller.mfaEnroll);
  router.post("/mfa/verify", authenticationMiddleware, mfaVerificationRateLimiter, controller.mfaVerify);
  router.get("/mfa/status", authenticationMiddleware, controller.mfaStatus);
  router.post("/mfa/recovery-codes/regenerate", authenticationMiddleware, recoveryMutationLimiter, validateEmptyMfaBody,
    createStepUpMiddleware({ purpose: "MFA_RECOVERY_CODES_REGENERATE", resourceId: (request) => request.auth?.userId, purposeRegistry: DEFAULT_STEP_UP_PURPOSES }),
    controller.mfaRecoveryCodesRegenerate);
  router.post("/mfa/disable", authenticationMiddleware, recoveryMutationLimiter, validateEmptyMfaBody,
    createStepUpMiddleware({ purpose: "MFA_DISABLE", resourceId: (request) => request.auth?.userId, purposeRegistry: DEFAULT_STEP_UP_PURPOSES }),
    controller.mfaDisable);
  router.post("/mfa/admin-enrollment/requests/:requestId/authorize", authenticationMiddleware, requireRole("ADMIN"), recoveryMutationLimiter,
    validateLegacyAdminRequest(mfaEnrollmentSchema),
    createStepUpMiddleware({ purpose: "LEGACY_ADMIN_MFA_ENROLL_AUTHORIZE", resourceId: (request) => request.params.requestId, purposeRegistry: DEFAULT_STEP_UP_PURPOSES }),
    controller.issueLegacyAdminEnrollmentAuthorization);
  router.post("/mfa/admin-enrollment/requests", authenticationMiddleware, requireRole("ADMIN"), requireAdminRecentTotp, recoveryMutationLimiter, controller.createLegacyAdminEnrollmentRequest);
  router.get("/mfa/admin-enrollment/legacy-admins", authenticationMiddleware, requireRole("ADMIN"), requireAdminRecentTotp, recoveryMutationLimiter, controller.listLegacyAdminAccounts);
  router.post("/mfa/admin-enrollment/requests/:requestId/identity", authenticationMiddleware, requireRole("ADMIN"), recoveryMutationLimiter,
    validateLegacyAdminRequest(recoveryIdentityReferenceSchema),
    createStepUpMiddleware({ purpose: "ADMIN_RECOVERY_IDENTITY_VERIFY", resourceId: (request) => request.params.requestId, purposeRegistry: DEFAULT_STEP_UP_PURPOSES }),
    controller.verifyLegacyAdminRecoveryIdentity);
  router.post("/mfa/admin-enrollment/requests/:requestId/approval", authenticationMiddleware, requireRole("ADMIN"), recoveryMutationLimiter,
    validateLegacyAdminRequest(recoveryApprovalSchema),
    createStepUpMiddleware({ purpose: "ADMIN_RECOVERY_APPROVAL", resourceId: (request) => request.params.requestId, purposeRegistry: DEFAULT_STEP_UP_PURPOSES }),
    controller.approveLegacyAdminRecovery);
  router.post("/mfa/legacy-admin-enrollment/start", challengeRateLimiter, controller.startLegacyAdminEnrollment);
  router.post("/mfa/legacy-admin-enrollment/verify", challengeRateLimiter, controller.verifyLegacyAdminEnrollment);
  router.post("/mfa/step-up/challenge", authenticationMiddleware, stepUpCreateRateLimiter, controller.mfaStepUpChallenge);
  router.post("/mfa/step-up/verify", authenticationMiddleware, stepUpVerifyRateLimiter, controller.mfaStepUpVerify);

  return router;
};
