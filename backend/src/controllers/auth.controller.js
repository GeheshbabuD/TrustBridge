import { ApiError } from "../utils/ApiError.js";
import {
  AuthServiceError,
  createAuthService,
} from "../services/auth.service.js";
import { loginSchema, logoutSchema, mfaChallengeVerificationSchema, refreshSchema, registrationSchema } from "../validators/auth.validator.js";
import { mfaEnrollmentSchema, mfaVerificationSchema } from "../validators/mfa.validator.js";
import { stepUpChallengeSchema, stepUpVerificationSchema } from "../validators/step-up.validator.js";
import { MfaServiceError } from "../services/mfa.service.js";

const validationError = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");

const forwardServiceError = (error, next) => {
  if (error instanceof AuthServiceError) {
    return next(new ApiError(error.statusCode, error.code, error.message));
  }
  return next(error);
};

export const createAuthController = ({ authService = createAuthService(), sessionService, mfaService } = {}) => ({
  register: async (request, response, next) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());

    try {
      const user = await authService.register(parsed.data);
      return response.status(201).json({
        success: true,
        message: "Account created successfully",
        data: { user },
      });
    } catch (error) {
      return forwardServiceError(error, next);
    }
  },

  login: async (request, response, next) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());

    try {
      const result = await authService.login(parsed.data);
      if (result.mfaRequired) {
        return response.status(202).json({
          success: true,
          message: "Additional verification is required",
          data: { mfaRequired: true, challengeToken: result.challengeToken, expiresAt: result.expiresAt },
        });
      }
      return response.status(200).json({
        success: true,
        message: "Authentication successful",
        data: result,
      });
    } catch (error) {
      return forwardServiceError(error, next);
    }
  },

  verifyMfaLogin: async (request, response, next) => {
    const parsed = mfaChallengeVerificationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      const tokens = await authService.verifyLoginChallenge(parsed.data);
      return response.status(200).json({ success: true, message: "Authentication successful", data: tokens });
    } catch (error) { return forwardServiceError(error, next); }
  },

  refresh: async (request, response, next) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      const tokens = await sessionService.refresh(parsed.data.refreshToken);
      return response.status(200).json({ success: true, message: "Session refreshed", data: tokens });
    } catch (error) { return forwardServiceError(error, next); }
  },

  logout: async (request, response, next) => {
    const parsed = logoutSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      await sessionService.logout(parsed.data.refreshToken);
      return response.status(200).json({ success: true, message: "Logged out", data: { loggedOut: true } });
    } catch (error) { return forwardServiceError(error, next); }
  },

  mfaEnroll: async (request, response, next) => {
    const parsed = mfaEnrollmentSchema.safeParse(request.body ?? {});
    if (!parsed.success) return next(validationError());
    try {
      const enrollment = await mfaService.startEnrollment({ userId: request.auth.userId, requestId: request.requestId });
      return response.status(201).json({ success: true, message: "MFA enrollment started", data: enrollment });
    } catch (error) {
      if (error instanceof MfaServiceError) return next(new ApiError(error.statusCode, error.code, error.message));
      return next(error);
    }
  },

  mfaVerify: async (request, response, next) => {
    const parsed = mfaVerificationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      const result = await mfaService.verifyEnrollment({ userId: request.auth.userId, code: parsed.data.code, requestId: request.requestId });
      return response.status(200).json({ success: true, message: "MFA enabled", data: result });
    } catch (error) {
      if (error instanceof MfaServiceError) return next(new ApiError(error.statusCode, error.code, error.message));
      return next(error);
    }
  },

  mfaStatus: async (request, response, next) => {
    try {
      const status = await mfaService.getStatus({ userId: request.auth.userId });
      return response.status(200).json({ success: true, message: "MFA status", data: status });
    } catch (error) {
      if (error instanceof MfaServiceError) return next(new ApiError(error.statusCode, error.code, error.message));
      return next(error);
    }
  },

  mfaStepUpChallenge: async (request, response, next) => {
    const parsed = stepUpChallengeSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      const challenge = await mfaService.createStepUpChallenge({ auth: request.auth, ...parsed.data });
      return response.status(201).json({ success: true, message: "Step-up verification started", data: challenge });
    } catch (error) {
      if (error instanceof MfaServiceError) return next(new ApiError(error.statusCode, error.code, error.message));
      return next(error);
    }
  },

  mfaStepUpVerify: async (request, response, next) => {
    const parsed = stepUpVerificationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try {
      const assurance = await mfaService.verifyStepUpChallenge({ auth: request.auth, ...parsed.data });
      return response.status(200).json({ success: true, message: "Step-up verification completed", data: assurance });
    } catch (error) {
      if (error instanceof MfaServiceError) return next(new ApiError(error.statusCode, error.code, error.message));
      return next(error);
    }
  },
});
