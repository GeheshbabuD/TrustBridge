import { Router } from "express";
import { createAuthController } from "../controllers/auth.controller.js";
import { createAuthService } from "../services/auth.service.js";
import { createSessionService } from "../services/session.service.js";
import { createMfaService } from "../services/mfa.service.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { createAuthLoginRateLimiter, createMfaChallengeRateLimiter, createMfaStepUpRateLimiter, createMfaVerificationRateLimiter } from "../middleware/rateLimit.middleware.js";
import { getEnv } from "../config/env.js";

export const createAuthRouter = (dependencies = {}) => {
  const sessionService = dependencies.sessionService ?? createSessionService();
  const mfaService = dependencies.mfaService ?? createMfaService({ ...(dependencies.environment ? { environment: dependencies.environment } : {}), ...(dependencies.stepUpPurposes ? { stepUpPurposes: dependencies.stepUpPurposes } : {}) });
  const authService = dependencies.authService ?? createAuthService({ sessionService, mfaService });
  const authenticationMiddleware = dependencies.authenticationMiddleware ?? requireAuthentication;
  const runtimeConfig = dependencies.environment ?? getEnv();
  const rateLimitConfig = runtimeConfig.mfa.verificationRateLimit;
  const mfaVerificationRateLimiter = dependencies.mfaVerificationRateLimiter ?? createMfaVerificationRateLimiter(rateLimitConfig);
  const loginRateLimiter = dependencies.authLoginRateLimiter ?? createAuthLoginRateLimiter(runtimeConfig.mfa.loginRateLimit);
  const challengeRateLimiter = dependencies.mfaChallengeRateLimiter ?? createMfaChallengeRateLimiter(runtimeConfig.mfa.challengeRateLimit);
  const stepUpCreateRateLimiter = dependencies.mfaStepUpCreateRateLimiter ?? createMfaStepUpRateLimiter(runtimeConfig.mfa.challengeRateLimit);
  const stepUpVerifyRateLimiter = dependencies.mfaStepUpVerifyRateLimiter ?? createMfaStepUpRateLimiter(runtimeConfig.mfa.challengeRateLimit);
  const router = Router();
  const controller = createAuthController({ authService, sessionService, mfaService });

  router.post("/register", controller.register);
  router.post("/login", loginRateLimiter, controller.login);
  router.post("/mfa/challenge/verify", challengeRateLimiter, controller.verifyMfaLogin);
  router.post("/refresh", controller.refresh);
  router.post("/logout", controller.logout);
  router.post("/mfa/enroll", authenticationMiddleware, controller.mfaEnroll);
  router.post("/mfa/verify", authenticationMiddleware, mfaVerificationRateLimiter, controller.mfaVerify);
  router.get("/mfa/status", authenticationMiddleware, controller.mfaStatus);
  router.post("/mfa/step-up/challenge", authenticationMiddleware, stepUpCreateRateLimiter, controller.mfaStepUpChallenge);
  router.post("/mfa/step-up/verify", authenticationMiddleware, stepUpVerifyRateLimiter, controller.mfaStepUpVerify);

  return router;
};
