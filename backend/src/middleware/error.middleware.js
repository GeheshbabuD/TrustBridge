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
  RATE_LIMIT_STORE_UNAVAILABLE: "Request protection is temporarily unavailable.",
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
  AUTH_REGISTRATION_RATE_LIMITED: "Too many registration attempts. Please try again later.",
  AUTH_SESSION_RATE_LIMITED: "Too many session requests. Please try again later.",
  MFA_CHALLENGE_RATE_LIMITED: "Too many verification attempts. Please try again later.",
  INVALID_MFA_CHALLENGE: "Authentication could not be completed",
  AUTHENTICATION_UNAVAILABLE: "Authentication is temporarily unavailable",
  MFA_ASSURANCE_REQUIRED: "Recent MFA verification is required",
  MFA_STEP_UP_REQUIRED: "Additional authentication is required",
  MFA_STEP_UP_PURPOSE_UNSUPPORTED: "The requested verification purpose is not supported",
  MFA_STEP_UP_RESOURCE_INVALID: "The requested resource binding is invalid",
  MFA_STEP_UP_RATE_LIMITED: "Too many verification attempts. Please try again later.",
  MFA_STEP_UP_UNAVAILABLE: "Additional authentication is temporarily unavailable",
  PAYMENT_OUTCOME_UNVERIFIED: "Payment status must be verified before cancellation",
  PAYMENT_UNAVAILABLE: "Payment service is temporarily unavailable",
  PAYMENT_CONFLICT: "Payment operation conflicts with current state",
  PAYMENT_TRANSACTION_INELIGIBLE: "Payment cannot be initiated for this transaction",
  PAYMENT_TERMS_UNAVAILABLE: "Accepted transaction terms are required",
  PAYMENT_ATTEMPT_ACTIVE: "A payment attempt is already active",
  PAYMENT_EVENT_MISMATCH: "Payment event could not be reconciled",
  PAYMENT_EVENT_UNVERIFIED: "Payment outcome could not be verified",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key was already used for a different operation",
  TRANSACTION_STORAGE_UNAVAILABLE: "Transaction service is temporarily unavailable",
  INVITATION_INVALID: "Invitation is invalid or unavailable",
  INVITATION_ALREADY_ACCEPTED: "Invitation is no longer available",
  TERMS_ACCEPTANCE_REQUIRED: "Both participants must accept the current terms first",
  TERMS_VERSION_CONFLICT: "Terms changed or were already decided",
  TRANSACTION_TERMS_LOCKED: "Terms can no longer be changed in the current transaction state",
  INVITATION_ACCEPTANCE_REQUIRED: "The seller invitation must be accepted first",
  TRANSACTION_TRANSITION_NOT_ALLOWED: "Transaction operation conflicts with current state",
  TRANSACTION_VERSION_CONFLICT: "Transaction operation conflicts with current state",
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
