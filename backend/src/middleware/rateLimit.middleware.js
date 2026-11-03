import rateLimit from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";

export const createApiRateLimiter = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(
        new ApiError(
          429,
          "RATE_LIMIT_EXCEEDED",
          "Too many requests. Please try again later.",
        ),
      );
    },
  });

export const createMfaVerificationRateLimiter = ({ windowMs = 600_000, max = 5, store } = {}) =>
  rateLimit({
    windowMs,
    limit: max,
    ...(store ? { store } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request) => request.auth?.userId ?? "unauthenticated",
    skipSuccessfulRequests: true,
    handler: (_request, _response, next) => next(
      new ApiError(429, "MFA_VERIFICATION_RATE_LIMITED", "Too many verification attempts. Please try again later."),
    ),
  });

const createAuthRateLimiter = ({ windowMs, max, code, message, store }) => rateLimit({
  windowMs,
  limit: max,
  ...(store ? { store } : {}),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, _response, next) => next(new ApiError(429, code, message)),
});

export const createAuthLoginRateLimiter = (options = {}) => createAuthRateLimiter({
  ...options,
  code: "AUTH_LOGIN_RATE_LIMITED",
  message: "Too many sign-in attempts. Please try again later.",
});

export const createMfaChallengeRateLimiter = (options = {}) => createAuthRateLimiter({
  ...options,
  code: "MFA_CHALLENGE_RATE_LIMITED",
  message: "Too many verification attempts. Please try again later.",
});

export const createMfaStepUpRateLimiter = (options = {}) => createAuthRateLimiter({
  ...options,
  code: "MFA_STEP_UP_RATE_LIMITED",
  message: "Too many verification attempts. Please try again later.",
});
