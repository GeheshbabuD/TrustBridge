import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "../utils/ApiError.js";
import { MemoryRateLimitStore } from "../services/rate-limit-store.service.js";

const localKeySecret = "trustbridge-test-and-development-rate-limit-key";

const privacyKey = (secret, value) => createHmac("sha256", secret).update(value).digest("hex");

const normalizedIdentity = (request) => {
  if (typeof request.auth?.userId === "string" && request.auth.userId.length <= 128) {
    return { scope: "authenticated-user", value: request.auth.userId };
  }
  const email = request.body?.email;
  if (typeof email === "string" && email.length <= 320) {
    const normalized = email.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return { scope: "account-email", value: normalized };
  }
  for (const field of ["challengeToken", "authorizationToken", "verificationToken", "refreshToken"]) {
    const token = request.body?.[field];
    if (typeof token === "string" && token.length >= 16 && token.length <= 512) {
      return { scope: "challenge-token", value: token };
    }
  }
  return null;
};

const safeRemoteAddress = (request) => {
  // Never consume X-Forwarded-For or other caller-controlled forwarding headers.
  const address = request.socket?.remoteAddress;
  if (typeof address !== "string" || address.length > 64) return "unknown";
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(normalized) === 4) return normalized;
  if (isIP(normalized) !== 6) return "unknown";
  const [left, right = ""] = normalized.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const groups = [...leftGroups, ...Array(Math.max(0, 8 - leftGroups.length - rightGroups.length)).fill("0"), ...rightGroups];
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
};

export const createSharedRateLimiter = ({
  store = new MemoryRateLimitStore(),
  keySecret = localKeySecret,
  windowMs,
  max,
  operation,
  family = "api",
  accountScope,
  accountMax = max,
  skipSuccessfulRequests = false,
  code = "RATE_LIMIT_EXCEEDED",
  message = "Too many requests. Please try again later.",
}) => {
  if (!store || typeof store.increment !== "function") throw new TypeError("A rate-limit store is required");
  if (!Number.isInteger(windowMs) || windowMs < 1000 || !Number.isInteger(max) || max < 1) throw new TypeError("Invalid rate-limit policy");

  return async (request, response, next) => {
    const actor = normalizedIdentity(request);
    const remoteAddress = safeRemoteAddress(request);
    const dimensions = [
      { kind: "operation", value: `${family}:${operation}:${remoteAddress}`, limit: max },
    ];
    if (actor && accountScope) dimensions.push({
      kind: actor.scope === "challenge-token" ? "challenge" : "account",
      value: `${accountScope}:${actor.scope}:${actor.value}`,
      limit: accountMax,
    });

    const keys = dimensions.map(({ kind, value }) => `tb:rl:v1:${privacyKey(keySecret, `${kind}\0${value}`)}`);
    let increments;
    try {
      increments = await Promise.all(keys.map((key) => store.increment(key, windowMs)));
    } catch {
      return next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."));
    }

    if (increments.some((bucket, index) => bucket.hits > dimensions[index].limit)) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((increments[0].resetAt - Date.now()) / 1000))));
      return next(new ApiError(429, code, message));
    }

    if (skipSuccessfulRequests) {
      response.once("finish", () => {
        if (response.statusCode < 400 && typeof store.decrement === "function") {
          void Promise.all(keys.map((key) => store.decrement(key))).catch(() => {});
        }
      });
    }
    return next();
  };
};

const policy = (options, operation, code, message, family = "authentication") => createSharedRateLimiter({
  ...options,
  operation,
  family,
  accountScope: options.accountScope ?? family,
  code,
  message,
});

export const createApiRateLimiter = (options = {}) => createSharedRateLimiter({
  ...options,
  operation: "api-v1",
  family: "api",
  accountScope: null,
  code: "RATE_LIMIT_EXCEEDED",
  message: "Too many requests. Please try again later.",
});

export const createMfaVerificationRateLimiter = (options = {}) => policy(
  { windowMs: 600_000, max: 5, ...options, skipSuccessfulRequests: true },
  options.operation ?? "mfa-verification",
  "MFA_VERIFICATION_RATE_LIMITED",
  "Too many verification attempts. Please try again later.",
);

export const createAuthLoginRateLimiter = (options = {}) => policy(
  options,
  "login",
  "AUTH_LOGIN_RATE_LIMITED",
  "Too many sign-in attempts. Please try again later.",
);

export const createAuthSessionRateLimiter = (options = {}) => policy(
  options,
  "session-token-operation",
  "AUTH_SESSION_RATE_LIMITED",
  "Too many session requests. Please try again later.",
);

export const createRegistrationRateLimiter = (options = {}) => policy(
  options,
  "registration",
  "AUTH_REGISTRATION_RATE_LIMITED",
  "Too many registration attempts. Please try again later.",
);

export const createMfaChallengeRateLimiter = (options = {}) => policy(
  options,
  "mfa-login-challenge",
  "MFA_CHALLENGE_RATE_LIMITED",
  "Too many verification attempts. Please try again later.",
);

export const createMfaStepUpRateLimiter = (options = {}) => policy(
  options,
  options.operation ?? "mfa-step-up",
  "MFA_STEP_UP_RATE_LIMITED",
  "Too many verification attempts. Please try again later.",
);

export const createRecoveryCodeLoginRateLimiter = (options = {}) => policy(
  options,
  "mfa-recovery-login",
  "MFA_CHALLENGE_RATE_LIMITED",
  "Too many verification attempts. Please try again later.",
);

export const createRecoveryMutationRateLimiter = (options = {}) => policy(
  options,
  options.operation ?? "mfa-recovery-mutation",
  "MFA_VERIFICATION_RATE_LIMITED",
  "Too many verification attempts. Please try again later.",
);

