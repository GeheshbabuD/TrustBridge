import { getPrismaClient } from "../config/db.js";
import { getEnv } from "../config/env.js";
import { createMfaCrypto, createLocalDevelopmentEncryptionProvider, MfaCryptoError } from "./mfa-crypto.service.js";
import { createMfaPersistenceService, MfaPersistenceError } from "./mfa-persistence.service.js";
import { generateTotpSecret, verifyTotp } from "./totp.service.js";
import { DEFAULT_STEP_UP_PURPOSES, resolveStepUpPurpose } from "./step-up-purpose.registry.js";

const ISSUER = "TrustBridge";

export class MfaServiceError extends Error {
  constructor(statusCode, code) {
    super("MFA operation could not be completed");
    this.name = "MfaServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const convertPersistenceError = (error) => {
  if (error instanceof MfaCryptoError) throw new MfaServiceError(503, "MFA_ENCRYPTION_UNAVAILABLE");
  if (!(error instanceof MfaPersistenceError)) throw new MfaServiceError(503, "MFA_STORAGE_UNAVAILABLE");
  if (error.code === "MFA_ALREADY_ENABLED") throw new MfaServiceError(409, error.code);
  if (error.code === "MFA_ENROLLMENT_PENDING") throw new MfaServiceError(409, error.code);
  if (error.code === "MFA_VERIFICATION_FAILED") throw new MfaServiceError(400, error.code);
  if (error.code === "MFA_ENROLLMENT_UNAVAILABLE") throw new MfaServiceError(409, error.code);
  if (error.code === "MFA_ACCOUNT_UNAVAILABLE") throw new MfaServiceError(401, "AUTHENTICATION_REQUIRED");
  if (error.code === "MFA_CHALLENGE_INVALID") throw new MfaServiceError(401, "INVALID_MFA_CHALLENGE");
  throw new MfaServiceError(503, "MFA_STORAGE_UNAVAILABLE");
};

const provisioningUri = (email, secret) => {
  const normalizedEmail = email.trim().toLowerCase();
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(normalizedEmail)}`;
  const query = new URLSearchParams({ secret, issuer: ISSUER, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
};

export const createMfaService = ({
  environment = getEnv(),
  getClient = getPrismaClient,
  persistence,
  encryptionProvider,
  now = () => new Date(),
  createSecret = generateTotpSecret,
  verify = verifyTotp,
  stepUpPurposes = DEFAULT_STEP_UP_PURPOSES,
} = {}) => {
  const provider = encryptionProvider ?? createLocalDevelopmentEncryptionProvider({ environment: () => environment });
  const store = persistence ?? createMfaPersistenceService({
    getClient,
    encryption: createMfaCrypto({ provider }),
    verifyTotp: verify,
    totpWindowSteps: environment.mfa.totpWindowSteps,
    now,
  });

  const loadActiveUser = async (userId) => {
    const client = await getClient();
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true, pendingExpiresAt: true } } },
    });
    if (!user || user.status !== "ACTIVE") throw new MfaServiceError(401, "AUTHENTICATION_REQUIRED");
    return { client, user };
  };

  const startEnrollment = async ({ userId, requestId } = {}) => {
    let user;
    try { ({ user } = await loadActiveUser(userId)); } catch (error) { if (error instanceof MfaServiceError) throw error; throw new MfaServiceError(503, "MFA_STORAGE_UNAVAILABLE"); }
    const secret = createSecret();
    try {
      const enrollment = await store.startEnrollment({ userId, secret, requestId });
      return Object.freeze({
        enrollmentId: enrollment.enrollmentId,
        expiresAt: enrollment.expiresAt,
        secret,
        provisioningUri: provisioningUri(user.email, secret),
      });
    } catch (error) { convertPersistenceError(error); }
  };

  const verifyEnrollment = async ({ userId, code, requestId } = {}) => {
    try {
      const result = await store.activateEnrollmentAndIssueRecoveryCodes({ userId, token: code, requestId });
      return Object.freeze({ enabled: true, recoveryCodes: result.codes });
    } catch (error) { convertPersistenceError(error); }
  };

  const getStatus = async ({ userId } = {}) => {
    let client;
    let user;
    try { ({ client, user } = await loadActiveUser(userId)); } catch (error) { if (error instanceof MfaServiceError) throw error; throw new MfaServiceError(503, "MFA_STORAGE_UNAVAILABLE"); }
    let unusedRecoveryCodes = 0;
    try {
      if (user.mfa?.enabledAt) {
        unusedRecoveryCodes = await client.mfaRecoveryCode.count({ where: { userId, consumedAt: null, invalidatedAt: null } });
      }
    } catch { throw new MfaServiceError(503, "MFA_STORAGE_UNAVAILABLE"); }
    const enabled = user.mfa?.enrollmentStatus === "ENABLED" && Boolean(user.mfa.enabledAt);
    const pending = user.mfa?.enrollmentStatus === "PENDING" && user.mfa.pendingExpiresAt > now();
    return Object.freeze({ enabled, enrollmentPending: pending, requiredByPolicy: user.role === "ADMIN", unusedRecoveryCodes });
  };

  const createLoginChallenge = async ({ userId, authVersion } = {}) => {
    const expiresAt = new Date(now().getTime() + environment.mfa.loginChallengeTtlSeconds * 1000);
    try {
      const challengeToken = await store.createChallenge({ userId, purpose: "LOGIN", authVersion, expiresAt });
      return Object.freeze({ challengeToken, expiresAt });
    } catch (error) { convertPersistenceError(error); }
  };

  const verifyLoginChallenge = async ({ challengeToken, code } = {}) => {
    if (typeof challengeToken !== "string" || typeof code !== "string" || !/^\d{6}$/.test(code)) {
      throw new MfaServiceError(401, "INVALID_MFA_CHALLENGE");
    }
    try {
      const result = await store.completeLoginChallenge({ token: challengeToken, code });
      if (!result) throw new MfaServiceError(401, "INVALID_MFA_CHALLENGE");
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof MfaServiceError) throw error;
      convertPersistenceError(error);
    }
  };

  const createStepUpChallenge = async ({ auth, purpose, resourceId } = {}) => {
    const definition = resolveStepUpPurpose(stepUpPurposes, purpose);
    if (!definition) throw new MfaServiceError(400, "MFA_STEP_UP_PURPOSE_UNSUPPORTED");
    if (!auth || typeof auth.userId !== "string" || typeof auth.sessionId !== "string"
      || !Number.isSafeInteger(auth.authVersion) || auth.mfaEnabled !== true
      || !(auth.mfaVerifiedAt instanceof Date) || !definition.allowedRoles.includes(auth.role)) {
      throw new MfaServiceError(403, "MFA_STEP_UP_REQUIRED");
    }
    if ((definition.resourceRequired && !resourceId) || (!definition.resourceRequired && resourceId !== undefined)
      || (resourceId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId))) {
      throw new MfaServiceError(400, "MFA_STEP_UP_RESOURCE_INVALID");
    }
    if (purpose === "MFA_RECOVERY_CODES_REGENERATE" && resourceId !== auth.userId) {
      throw new MfaServiceError(403, "MFA_STEP_UP_REQUIRED");
    }
    const expiresAt = new Date(now().getTime() + environment.mfa.stepUpChallengeTtlSeconds * 1000);
    try {
      const challengeToken = await store.createStepUpChallenge({
        userId: auth.userId,
        sessionId: auth.sessionId,
        authVersion: auth.authVersion,
        mfaVerifiedAt: auth.mfaVerifiedAt,
        purpose,
        resourceType: definition.resourceType,
        resourceId: resourceId ?? auth.userId,
        allowedRoles: definition.allowedRoles,
        expiresAt,
      });
      return Object.freeze({ challengeToken, purpose, resourceType: definition.resourceType, resourceId: resourceId ?? auth.userId, expiresAt });
    } catch (error) { convertPersistenceError(error); }
  };

  const verifyStepUpChallenge = async ({ auth, challengeToken, code } = {}) => {
    if (typeof challengeToken !== "string" || typeof code !== "string" || !/^\d{6}$/.test(code)
      || !auth || typeof auth.userId !== "string" || typeof auth.sessionId !== "string"
      || !Number.isSafeInteger(auth.authVersion) || auth.mfaEnabled !== true) {
      throw new MfaServiceError(401, "INVALID_MFA_CHALLENGE");
    }
    const allowedPurposes = Object.fromEntries(
      Object.entries(stepUpPurposes instanceof Map ? Object.fromEntries(stepUpPurposes) : stepUpPurposes)
        .map(([purpose, definition]) => [purpose, { allowedRoles: definition.allowedRoles, resourceType: definition.resourceType, resourceRequired: definition.resourceRequired }]),
    );
    try {
      const result = await store.completeStepUpChallenge({
        token: challengeToken,
        code,
        userId: auth.userId,
        sessionId: auth.sessionId,
        authVersion: auth.authVersion,
        allowedPurposes,
      });
      if (!result) throw new MfaServiceError(401, "INVALID_MFA_CHALLENGE");
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof MfaServiceError) throw error;
      convertPersistenceError(error);
    }
  };

  return Object.freeze({ startEnrollment, verifyEnrollment, getStatus, createLoginChallenge, verifyLoginChallenge, createStepUpChallenge, verifyStepUpChallenge });
};
