import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { createOpaqueSecret } from "./mfa-crypto.service.js";

export class MfaPersistenceError extends Error {
  constructor(code = "MFA_OPERATION_FAILED") {
    super("MFA operation could not be completed");
    this.name = "MfaPersistenceError";
    this.code = code;
  }
}

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const normalizeCode = (value) => typeof value === "string" ? value.replace(/[-\s]/g, "").toUpperCase() : "";
const audit = (tx, actorUserId, action, entityType, entityId, metadata = {}) => tx.auditLog.create({
  data: { actorUserId, action, entityType, entityId, metadata },
  select: { id: true },
});
const assertId = (value) => { if (typeof value !== "string" || !value) throw new MfaPersistenceError("MFA_INVALID_INPUT"); };

export const createMfaPersistenceService = ({
  getClient = getPrismaClient,
  encryption,
  verifyTotp,
  verifyIndependentIdentity,
  now = () => new Date(),
  totpWindowSteps = 1,
  makeId = randomUUID,
  makeRecoveryCode = () => randomBytes(16).toString("hex").toUpperCase(),
  makeChallenge = createOpaqueSecret,
} = {}) => {
  if (!encryption || typeof encryption.encrypt !== "function" || typeof encryption.decrypt !== "function") {
    throw new TypeError("MFA encryption provider is required");
  }
  if (!Number.isInteger(totpWindowSteps) || totpWindowSteps < 0 || totpWindowSteps > 2) throw new TypeError("TOTP clock window must be an integer from zero through two steps");
  const get = async () => getClient();

  const generateRecoveryBatch = () => {
    const codes = Array.from({ length: 10 }, makeRecoveryCode);
    if (codes.some((code) => typeof code !== "string" || code.length < 32)) throw new MfaPersistenceError();
    return { codes, batchId: makeId() };
  };

  const persistRecoveryBatch = async (tx, userId, codes, batchId) => {
    const timestamp = now();
    await tx.mfaRecoveryCode.updateMany({ where: { userId, consumedAt: null, invalidatedAt: null }, data: { invalidatedAt: timestamp } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((code) => ({ userId, batchId, codeHash: hash(normalizeCode(code)), createdAt: timestamp })) });
    await audit(tx, userId, "MFA_RECOVERY_CODES_REGENERATED", "UserMfa", userId, { count: codes.length, batchId });
    return { batchId, codes: Object.freeze(codes) };
  };

  const startEnrollment = async ({ userId, secret, requestId } = {}) => {
    assertId(userId);
    const sealed = await encryption.encrypt(secret, { userId, purpose: "totp-pending" });
    const client = await get();
    const pendingExpiresAt = new Date(now().getTime() + 10 * 60_000);
    try {
      return await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        if (!user || user.status !== "ACTIVE") throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        const existing = await tx.userMfa.findUnique({ where: { userId }, select: { id: true, enrollmentStatus: true, enabledAt: true, pendingExpiresAt: true } });
        if (existing?.enabledAt || existing?.enrollmentStatus === "ENABLED") throw new MfaPersistenceError("MFA_ALREADY_ENABLED");
        if (existing?.enrollmentStatus === "PENDING" && existing.pendingExpiresAt > now()) throw new MfaPersistenceError("MFA_ENROLLMENT_PENDING");
        const pendingData = { enrollmentStatus: "PENDING", pendingCiphertext: sealed.ciphertext, pendingNonce: sealed.nonce, pendingAuthTag: sealed.authTag, pendingKeyId: sealed.keyId, pendingKeyVersion: sealed.keyVersion, pendingExpiresAt };
        let record;
        if (existing) {
          const claimed = await tx.userMfa.updateMany({
            where: {
              id: existing.id,
              enabledAt: null,
              OR: [
                { enrollmentStatus: "DISABLED", pendingCiphertext: null },
                { enrollmentStatus: "PENDING", pendingExpiresAt: { lte: now() } },
              ],
            },
            data: pendingData,
          });
          if (claimed.count !== 1) throw new MfaPersistenceError("MFA_ENROLLMENT_PENDING");
          record = { id: existing.id };
        } else {
          record = await tx.userMfa.create({ data: { userId, ...pendingData }, select: { id: true } });
        }
        await audit(tx, userId, "MFA_ENROLLMENT_STARTED", "UserMfa", record.id, requestId ? { requestId } : {});
        return { enrollmentId: record.id, expiresAt: pendingExpiresAt };
      });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const activateEnrollment = async ({ userId, token, requestId, includeRecoveryCodes = false } = {}) => {
    assertId(userId);
    if (typeof token !== "string" || !/^\d{6}$/.test(token) || typeof verifyTotp !== "function") throw new MfaPersistenceError("MFA_VERIFICATION_FAILED");
    const recoveryBatch = includeRecoveryCodes ? generateRecoveryBatch() : null;
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        const record = await tx.userMfa.findUnique({ where: { userId } });
        if (!user || user.status !== "ACTIVE" || record?.enrollmentStatus !== "PENDING" || !record.pendingCiphertext || !record.pendingExpiresAt || record.pendingExpiresAt <= now()) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const secret = await encryption.decrypt({ ciphertext: record.pendingCiphertext, nonce: record.pendingNonce, authTag: record.pendingAuthTag, keyId: record.pendingKeyId, keyVersion: record.pendingKeyVersion }, { userId, purpose: "totp-pending" });
        const result = await verifyTotp(secret, token, { stepSeconds: 30, digits: 6, window: totpWindowSteps, at: now() });
        if (!result?.valid || !Number.isSafeInteger(result.timeStep)) throw new MfaPersistenceError("MFA_VERIFICATION_FAILED");
        const claimed = await tx.userMfa.updateMany({ where: { id: record.id, enrollmentStatus: "PENDING", pendingExpiresAt: { gt: now() }, user: { status: "ACTIVE" } }, data: {
          enrollmentStatus: "ENABLED",
          secretCiphertext: record.pendingCiphertext, secretNonce: record.pendingNonce, secretAuthTag: record.pendingAuthTag, secretKeyId: record.pendingKeyId, secretKeyVersion: record.pendingKeyVersion,
          enabledAt: now(), lastAcceptedTimeStep: BigInt(result.timeStep), pendingCiphertext: null, pendingNonce: null, pendingAuthTag: null, pendingKeyId: null, pendingKeyVersion: null, pendingExpiresAt: null,
        } });
        if (claimed.count !== 1) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        await audit(tx, userId, "MFA_ENABLED", "UserMfa", record.id, requestId ? { requestId } : {});
        if (!recoveryBatch) return { enabled: true };
        const issued = await persistRecoveryBatch(tx, userId, recoveryBatch.codes, recoveryBatch.batchId);
        return { enabled: true, ...issued };
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const activateEnrollmentAndIssueRecoveryCodes = (input) => activateEnrollment({ ...input, includeRecoveryCodes: true });

  const advanceTimeStep = async ({ userId, timeStep } = {}) => {
    assertId(userId);
    if (!Number.isSafeInteger(timeStep) || timeStep < 0) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const result = await tx.userMfa.updateMany({
          where: { userId, enabledAt: { not: null }, user: { status: "ACTIVE" }, OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: BigInt(timeStep) } }] },
          data: { lastAcceptedTimeStep: BigInt(timeStep) },
        });
        if (result.count !== 1) return false;
        await audit(tx, userId, "MFA_TOTP_STEP_ACCEPTED", "UserMfa", userId, { timeStep });
        return true;
      }, { isolationLevel: "Serializable" });
    } catch { throw new MfaPersistenceError(); }
  };

  const createRecoveryCodeBatch = async ({ userId } = {}) => {
    assertId(userId);
    const { codes, batchId } = generateRecoveryBatch();
    const client = await get();
    try {
      await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        const mfa = await tx.userMfa.findUnique({ where: { userId }, select: { enabledAt: true } });
        if (!user || user.status !== "ACTIVE" || !mfa?.enabledAt) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await persistRecoveryBatch(tx, userId, codes, batchId);
      }, { isolationLevel: "Serializable" });
      return Object.freeze({ batchId, codes: Object.freeze(codes) });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const consumeRecoveryCode = async ({ userId, code } = {}) => {
    assertId(userId);
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        if (!user || user.status !== "ACTIVE") return false;
        const result = await tx.mfaRecoveryCode.updateMany({ where: { userId, codeHash: hash(normalized), consumedAt: null, invalidatedAt: null }, data: { consumedAt: now() } });
        if (result.count !== 1) return false;
        await audit(tx, userId, "MFA_RECOVERY_CODE_CONSUMED", "User", userId);
        return true;
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const createChallenge = async ({ userId, purpose, authVersion = 0, expiresAt } = {}) => {
    assertId(userId);
    if (!["LOGIN", "ACCOUNT_RECOVERY"].includes(purpose) || !Number.isSafeInteger(authVersion) || authVersion < 0 || !(expiresAt instanceof Date) || expiresAt <= now()) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    const token = makeChallenge();
    const client = await get();
    try {
      await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, role: true, authVersion: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } });
        const mfaEnabled = user?.mfa?.enrollmentStatus === "ENABLED" && Boolean(user.mfa.enabledAt);
        if (!user || user.status !== "ACTIVE" || user.authVersion !== authVersion || (purpose === "LOGIN" && (!mfaEnabled || (user.role === "ADMIN" && !mfaEnabled)))) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await tx.mfaChallenge.create({ data: { userId, purpose, tokenHash: hash(token), authVersion, expiresAt }, select: { id: true } });
      }, { isolationLevel: "Serializable" });
      return token;
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const createStepUpChallenge = async ({ userId, sessionId, authVersion, mfaVerifiedAt, purpose, resourceType, resourceId, allowedRoles, expiresAt } = {}) => {
    assertId(userId); assertId(sessionId);
    if (!Number.isSafeInteger(authVersion) || authVersion < 0 || !(mfaVerifiedAt instanceof Date)
      || !Number.isFinite(mfaVerifiedAt.getTime()) || typeof purpose !== "string"
      || typeof resourceType !== "string" || typeof resourceId !== "string" || !resourceId
      || !Array.isArray(allowedRoles) || allowedRoles.length === 0
      || !(expiresAt instanceof Date) || expiresAt <= now()) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    const token = makeChallenge();
    const client = await get();
    try {
      await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: {
          status: true, role: true, authVersion: true,
          mfa: { select: { enrollmentStatus: true, enabledAt: true, secretCiphertext: true } },
        } });
        const session = await tx.refreshToken.findUnique({ where: { id: sessionId }, select: {
          id: true, userId: true, authVersion: true, mfaVerifiedAt: true, expiresAt: true, revokedAt: true,
        } });
        const enabledAt = user?.mfa?.enabledAt;
        if (!user || user.status !== "ACTIVE" || user.authVersion !== authVersion || !allowedRoles.includes(user.role)
          || user.mfa?.enrollmentStatus !== "ENABLED" || !(enabledAt instanceof Date) || !user.mfa.secretCiphertext
          || !session || session.userId !== userId || session.authVersion !== authVersion
          || session.revokedAt || session.expiresAt <= now() || !session.mfaVerifiedAt
          || Math.floor(session.mfaVerifiedAt.getTime() / 1000) !== Math.floor(mfaVerifiedAt.getTime() / 1000)) {
          throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        }
        await tx.mfaChallenge.create({ data: {
          userId, sessionId, purpose: "STEP_UP", operationPurpose: purpose, resourceType, resourceId, mfaEnabledAt: enabledAt,
          tokenHash: hash(token), authVersion, expiresAt,
        }, select: { id: true } });
      }, { isolationLevel: "Serializable" });
      return token;
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const completeStepUpChallenge = async ({ token, code, userId, sessionId, authVersion, allowedPurposes } = {}) => {
    if (typeof token !== "string" || !token || typeof code !== "string" || !/^\d{6}$/.test(code)
      || typeof userId !== "string" || typeof sessionId !== "string" || !Number.isSafeInteger(authVersion)
      || !allowedPurposes || typeof allowedPurposes !== "object"
      || typeof verifyTotp !== "function") return null;
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: {
          id: true, userId: true, sessionId: true, purpose: true, operationPurpose: true, resourceType: true, resourceId: true,
          mfaEnabledAt: true, authVersion: true, attemptCount: true, expiresAt: true, consumedAt: true,
          verifiedAt: true,
          user: { select: { id: true, role: true, status: true, authVersion: true, mfa: { select: {
            id: true, enrollmentStatus: true, enabledAt: true, secretCiphertext: true, secretNonce: true,
            secretAuthTag: true, secretKeyId: true, secretKeyVersion: true, lastAcceptedTimeStep: true,
          } } } },
          session: { select: { id: true, userId: true, authVersion: true, mfaVerifiedAt: true, expiresAt: true, revokedAt: true } },
        } });
        const currentTime = now();
        const user = challenge?.user;
        const mfa = user?.mfa;
        const session = challenge?.session;
        const purpose = challenge?.operationPurpose;
        const purposePolicy = allowedPurposes[purpose];
        const resourceType = challenge?.resourceType;
        const resourceId = challenge?.resourceId;
        const mfaEnabled = mfa?.enrollmentStatus === "ENABLED" && mfa.enabledAt instanceof Date && Boolean(mfa.secretCiphertext);
        const bound = challenge && challenge.purpose === "STEP_UP" && purposePolicy
          && Array.isArray(purposePolicy.allowedRoles) && purposePolicy.allowedRoles.includes(user?.role)
          && challenge.userId === userId && challenge.sessionId === sessionId
          && resourceType === purposePolicy.resourceType && typeof resourceId === "string" && Boolean(resourceId)
          && (!purposePolicy.resourceRequired || Boolean(resourceId))
          && challenge.authVersion === authVersion && user?.id === userId && user.status === "ACTIVE"
          && user.authVersion === authVersion && mfaEnabled && challenge.mfaEnabledAt?.getTime() === mfa.enabledAt.getTime()
          && session?.id === sessionId && session.userId === userId && session.authVersion === authVersion
          && session.revokedAt === null && session.expiresAt > currentTime && Boolean(session.mfaVerifiedAt)
          && !challenge.consumedAt && !challenge.verifiedAt && challenge.expiresAt > currentTime && challenge.attemptCount < 5;
        if (!bound) return null;

        const recordFailure = async () => {
          await tx.mfaChallenge.updateMany({ where: {
            id: challenge.id, purpose: "STEP_UP", operationPurpose: purpose, userId, sessionId, authVersion,
            resourceType, resourceId, attemptCount: { equals: challenge.attemptCount, lt: 5 },
            consumedAt: null, verifiedAt: null, expiresAt: { gt: now() },
            user: { is: { status: "ACTIVE", authVersion } },
            session: { is: { userId, authVersion, revokedAt: null, expiresAt: { gt: now() } } },
          }, data: { attemptCount: { increment: 1 } } });
          return null;
        };

        const secret = await encryption.decrypt({
          ciphertext: mfa.secretCiphertext, nonce: mfa.secretNonce, authTag: mfa.secretAuthTag,
          keyId: mfa.secretKeyId, keyVersion: mfa.secretKeyVersion,
        }, { userId, purpose: "totp-pending" });
        const matched = await verifyTotp(secret, code, { stepSeconds: 30, digits: 6, window: totpWindowSteps, at: currentTime });
        if (!matched?.valid || !Number.isSafeInteger(matched.timeStep)) return recordFailure();

        const stepClaim = await tx.userMfa.updateMany({ where: {
          id: mfa.id, userId, enrollmentStatus: "ENABLED", enabledAt: challenge.mfaEnabledAt,
          user: { is: { status: "ACTIVE", authVersion } },
          OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: BigInt(matched.timeStep) } }],
        }, data: { lastAcceptedTimeStep: BigInt(matched.timeStep) } });
        if (stepClaim.count !== 1) return recordFailure();

        const verifiedAt = now();
        const consumed = await tx.mfaChallenge.updateMany({ where: {
          id: challenge.id, purpose: "STEP_UP", operationPurpose: purpose, userId, sessionId, authVersion, resourceType, resourceId,
          mfaEnabledAt: challenge.mfaEnabledAt, attemptCount: { equals: challenge.attemptCount, lt: 5 },
          consumedAt: null, verifiedAt: null, expiresAt: { gt: verifiedAt },
          user: { is: { status: "ACTIVE", authVersion, mfa: { is: { enrollmentStatus: "ENABLED", enabledAt: challenge.mfaEnabledAt } } } },
          session: { is: { userId, authVersion, revokedAt: null, expiresAt: { gt: verifiedAt } } },
        }, data: { consumedAt: verifiedAt, verifiedAt } });
        if (consumed.count !== 1) throw new MfaPersistenceError("MFA_CHALLENGE_INVALID");
        await audit(tx, userId, "MFA_STEP_UP_VERIFIED", "MfaChallenge", challenge.id, { purpose, resourceType, resourceId });
        return Object.freeze({ purpose, resourceType, resourceId, verifiedAt });
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof MfaPersistenceError && error.code === "MFA_CHALLENGE_INVALID") return null;
      throw new MfaPersistenceError();
    }
  };

  const completeLoginChallenge = async ({ token, code } = {}) => {
    if (typeof token !== "string" || !token || typeof code !== "string" || !/^\d{6}$/.test(code) || typeof verifyTotp !== "function") return null;
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: {
          id: true, purpose: true, authVersion: true, attemptCount: true, expiresAt: true, consumedAt: true,
          user: { select: { id: true, role: true, status: true, authVersion: true, mfa: { select: {
            id: true, enrollmentStatus: true, enabledAt: true, secretCiphertext: true, secretNonce: true,
            secretAuthTag: true, secretKeyId: true, secretKeyVersion: true, lastAcceptedTimeStep: true,
          } } } },
        } });
        const currentTime = now();
        const user = challenge?.user;
        const mfa = user?.mfa;
        const mfaEnabled = mfa?.enrollmentStatus === "ENABLED" && Boolean(mfa.enabledAt) && Boolean(mfa.secretCiphertext);
        if (!challenge || challenge.purpose !== "LOGIN" || !user || user.status !== "ACTIVE" || user.authVersion !== challenge.authVersion || !mfaEnabled || challenge.consumedAt || challenge.expiresAt <= currentTime || challenge.attemptCount >= 5) return null;

        const recordFailure = async () => {
          await tx.mfaChallenge.updateMany({ where: {
            id: challenge.id, purpose: "LOGIN", authVersion: challenge.authVersion,
            attemptCount: { equals: challenge.attemptCount, lt: 5 },
            consumedAt: null, expiresAt: { gt: now() }, user: { status: "ACTIVE", authVersion: challenge.authVersion },
          }, data: { attemptCount: { increment: 1 } } });
          return null;
        };

        const secret = await encryption.decrypt({
          ciphertext: mfa.secretCiphertext, nonce: mfa.secretNonce, authTag: mfa.secretAuthTag,
          keyId: mfa.secretKeyId, keyVersion: mfa.secretKeyVersion,
        }, { userId: user.id, purpose: "totp-pending" });
        const matched = await verifyTotp(secret, code, { stepSeconds: 30, digits: 6, window: totpWindowSteps, at: currentTime });
        if (!matched?.valid || !Number.isSafeInteger(matched.timeStep)) return recordFailure();

        const stepClaim = await tx.userMfa.updateMany({ where: {
          id: mfa.id, userId: user.id, enrollmentStatus: "ENABLED", enabledAt: { not: null },
          user: { status: "ACTIVE", authVersion: challenge.authVersion },
          OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: BigInt(matched.timeStep) } }],
        }, data: { lastAcceptedTimeStep: BigInt(matched.timeStep) } });
        if (stepClaim.count !== 1) return recordFailure();

        const consumed = await tx.mfaChallenge.updateMany({ where: {
          id: challenge.id, purpose: "LOGIN", authVersion: challenge.authVersion,
          attemptCount: { equals: challenge.attemptCount }, consumedAt: null, expiresAt: { gt: now() },
          user: { status: "ACTIVE", authVersion: challenge.authVersion },
        }, data: { consumedAt: now() } });
        if (consumed.count !== 1) throw new MfaPersistenceError("MFA_CHALLENGE_INVALID");
        const mfaVerifiedAt = now();
        await audit(tx, user.id, "MFA_LOGIN_VERIFIED", "MfaChallenge", challenge.id);
        return { userId: user.id, role: user.role, authVersion: user.authVersion, mfaVerifiedAt };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof MfaPersistenceError && error.code === "MFA_CHALLENGE_INVALID") return null;
      throw new MfaPersistenceError();
    }
  };

  const recordChallengeFailure = async ({ token } = {}) => {
    if (typeof token !== "string" || !token) return false;
    try {
      const client = await get();
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: { id: true, authVersion: true, attemptCount: true, expiresAt: true, consumedAt: true, user: { select: { status: true, authVersion: true } } } });
        if (!challenge || !challenge.user || challenge.user.status !== "ACTIVE" || challenge.user.authVersion !== challenge.authVersion || challenge.consumedAt || challenge.expiresAt <= now() || challenge.attemptCount >= 5) return false;
        const result = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, authVersion: challenge.authVersion, consumedAt: null, expiresAt: { gt: now() }, attemptCount: { lt: 5 }, user: { status: "ACTIVE" } }, data: { attemptCount: { increment: 1 } } });
        return result.count === 1;
      }, { isolationLevel: "Serializable" });
    } catch { throw new MfaPersistenceError(); }
  };

  const consumeChallenge = async ({ token, purpose } = {}) => {
    if (typeof token !== "string" || !token || purpose === "STEP_UP") return false;
    try {
      const client = await get();
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: { id: true, purpose: true, authVersion: true, attemptCount: true, expiresAt: true, consumedAt: true, user: { select: { status: true, authVersion: true } } } });
        if (!challenge || !challenge.user || challenge.user.status !== "ACTIVE" || challenge.user.authVersion !== challenge.authVersion || challenge.purpose !== purpose || challenge.consumedAt || challenge.expiresAt <= now() || challenge.attemptCount >= 5) return false;
        const result = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, purpose, authVersion: challenge.authVersion, consumedAt: null, expiresAt: { gt: now() }, attemptCount: { lt: 5 }, user: { status: "ACTIVE" } }, data: { consumedAt: now() } });
        return result.count === 1;
      }, { isolationLevel: "Serializable" });
    } catch { throw new MfaPersistenceError(); }
  };

  const createAccountRecoveryRequest = async ({ userId, requestedByUserId = null, expiresAt } = {}) => {
    assertId(userId);
    if (!(expiresAt instanceof Date) || expiresAt <= now()) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    try {
      const client = await get();
      return await client.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
        if (!user || user.status !== "ACTIVE") throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        return tx.accountRecoveryRequest.create({ data: { userId, requestedByUserId, expiresAt }, select: { id: true, status: true, expiresAt: true } });
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const verifyRecoveryIdentity = async ({ requestId, evidenceReference } = {}) => {
    assertId(requestId);
    if (typeof evidenceReference !== "string" || !evidenceReference || evidenceReference.length > 255 || typeof verifyIndependentIdentity !== "function") throw new MfaPersistenceError("MFA_IDENTITY_VERIFICATION_UNAVAILABLE");
    let verified = false;
    try { verified = await verifyIndependentIdentity({ requestId, evidenceReference }); } catch { verified = false; }
    if (!verified) throw new MfaPersistenceError("MFA_IDENTITY_VERIFICATION_FAILED");
    try {
      const client = await get();
      const result = await client.accountRecoveryRequest.updateMany({ where: { id: requestId, status: "PENDING", identityVerifiedAt: null, expiresAt: { gt: now() }, user: { status: "ACTIVE" } }, data: { identityVerifiedAt: now(), identityVerificationRef: evidenceReference, version: { increment: 1 } } });
      if (result.count !== 1) throw new MfaPersistenceError("MFA_RECOVERY_REQUEST_UNAVAILABLE");
      return true;
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const recordRecoveryApproval = async ({ requestId, approverId, decision, reasonCode } = {}) => {
    assertId(requestId); assertId(approverId);
    if (!["APPROVE", "REJECT"].includes(decision)) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const approver = await tx.user.findUnique({ where: { id: approverId }, select: { id: true, role: true, status: true } });
        const request = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true, version: true } });
        const subject = request ? await tx.user.findUnique({ where: { id: request.userId }, select: { status: true } }) : null;
        if (!approver || approver.role !== "ADMIN" || approver.status !== "ACTIVE" || !request || !subject || subject.status !== "ACTIVE" || request.status !== "PENDING" || !request.identityVerifiedAt || request.expiresAt <= now() || request.userId === approverId) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        const approval = await tx.recoveryApproval.create({ data: { requestId, approverId, decision, reasonCode }, select: { id: true } });
        let nextStatus = request.status;
        if (decision === "REJECT") nextStatus = "REJECTED";
        else {
          const approvals = await tx.recoveryApproval.count({ where: { requestId, decision: "APPROVE" } });
          if (approvals >= 2) nextStatus = "APPROVED";
        }
        const updated = await tx.accountRecoveryRequest.updateMany({ where: { id: requestId, status: "PENDING", version: request.version }, data: { status: nextStatus, version: { increment: 1 } } });
        if (updated.count !== 1) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
        await audit(tx, approverId, "ACCOUNT_RECOVERY_APPROVAL_RECORDED", "AccountRecoveryRequest", requestId, { decision, status: nextStatus, approvalId: approval.id, reasonCode: reasonCode ?? null });
        return { status: nextStatus };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof MfaPersistenceError) throw error;
      // Unique conflict means this approver already decided; never expose Prisma details.
      throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
    }
  };

  return Object.freeze({ startEnrollment, activateEnrollment, activateEnrollmentAndIssueRecoveryCodes, advanceTimeStep, createRecoveryCodeBatch, consumeRecoveryCode, createChallenge, createStepUpChallenge, completeStepUpChallenge, completeLoginChallenge, recordChallengeFailure, consumeChallenge, createAccountRecoveryRequest, verifyRecoveryIdentity, recordRecoveryApproval });
};
