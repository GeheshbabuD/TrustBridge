import { ApiError } from "../utils/ApiError.js";

const bodyParserErrors = Object.freeze({
  "entity.parse.failed": [400, "MALFORMED_JSON", "Malformed JSON request body"],
  "entity.too.large": [413, "PAYLOAD_TOO_LARGE", "Request body is too large"],
  "parameters.too.many": [413, "TOO_MANY_PARAMETERS", "Too many form parameters"],
  "encoding.unsupported": [415, "UNSUPPORTED_CONTENT_ENCODING", "Unsupported content encoding"],
  "charset.unsupported": [415, "UNSUPPORTED_CHARSET", "Unsupported request charset"],
  "request.size.invalid": [400, "INVALID_CONTENT_LENGTH", "Invalid request body length"],
  "request.aborted": [400, "REQUEST_ABORTED", "Request body was not received completely"],
  "entity.verify.failed": [403, "REQUEST_BODY_REJECTED", "Request body was rejected"],
});

const safeApiMessages = Object.freeze({
  NOT_FOUND: "Route not found",
  CORS_ORIGIN_DENIED: "Origin is not allowed",
  RATE_LIMIT_EXCEEDED: "Too many requests. Please try again later.",
  VALIDATION_ERROR: "Request validation failed",
  REGISTRATION_CONFLICT: "Unable to create account with those details",
  INVALID_CREDENTIALS: "Email or password is incorrect",
  INVALID_REFRESH_TOKEN: "Refresh token is invalid or expired",
  AUTHENTICATION_REQUIRED: "Authentication is required",
  ACCOUNT_UNAVAILABLE: "Authentication is required",
  FORBIDDEN: "Access is not permitted",
  RESOURCE_NOT_FOUND: "Resource not found",
  MFA_VERIFICATION_RATE_LIMITED: "Too many verification attempts. Please try again later.",
  MFA_ENROLLMENT_PENDING: "An enrollment is already pending",
  MFA_ALREADY_ENABLED: "MFA is already enabled",
  MFA_ENROLLMENT_UNAVAILABLE: "Enrollment cannot be verified",
  MFA_VERIFICATION_FAILED: "Verification failed",
  MFA_ENCRYPTION_UNAVAILABLE: "MFA enrollment is temporarily unavailable",
  MFA_STORAGE_UNAVAILABLE: "MFA service is temporarily unavailable",
  AUTH_LOGIN_RATE_LIMITED: "Too many sign-in attempts. Please try again later.",
  MFA_CHALLENGE_RATE_LIMITED: "Too many verification attempts. Please try again later.",
  INVALID_MFA_CHALLENGE: "Authentication could not be completed",
  AUTHENTICATION_UNAVAILABLE: "Authentication is temporarily unavailable",
  MFA_ASSURANCE_REQUIRED: "Recent MFA verification is required",
  MFA_STEP_UP_REQUIRED: "Additional authentication is required",
  MFA_STEP_UP_PURPOSE_UNSUPPORTED: "The requested verification purpose is not supported",
  MFA_STEP_UP_RESOURCE_INVALID: "The requested resource binding is invalid",
  MFA_STEP_UP_RATE_LIMITED: "Too many verification attempts. Please try again later.",
  MFA_STEP_UP_UNAVAILABLE: "Additional authentication is temporarily unavailable",
});

const errorPayload = (requestId, code, message) => ({
  success: false,
  message,
  data: null,
  error: { code },
  requestId,
});

export const errorHandler = (error, request, response, next) => {
  if (response.headersSent) return next(error);

  if (error instanceof ApiError && (error.statusCode < 500 || safeApiMessages[error.code])) {
    const message = safeApiMessages[error.code] ?? "Request could not be processed";
    return response
      .status(error.statusCode)
      .json(errorPayload(request.requestId, error.code, message));
  }

  const parserError = bodyParserErrors[error?.type];
  if (parserError) {
    const [statusCode, code, message] = parserError;
    return response.status(statusCode).json(errorPayload(request.requestId, code, message));
  }

  return response
    .status(500)
    .json(
      errorPayload(request.requestId, "INTERNAL_SERVER_ERROR", "An unexpected error occurred"),
    );
};
