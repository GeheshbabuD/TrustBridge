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
  deliverLegacyAdminEnrollmentAuthorization,
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

  // All operations that replace or disable an enrollment take this row lock
  // before reading its state. This serializes recovery-code replacement with
  // enrollment changes without relying on process-local locks.
  const lockMfaRow = async (tx, userId) => tx.$queryRaw`
    SELECT "id" FROM "user_mfa" WHERE "user_id" = ${userId}::uuid FOR UPDATE
  `;
  const lockUserRow = async (tx, userId) => tx.$queryRaw`
    SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
  `;
  const lockSessionRow = async (tx, sessionId) => tx.$queryRaw`
    SELECT "id" FROM "refresh_tokens" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;

  const eligibleRecoveryApprovers = async (tx, requestId, subjectId) => {
    const rows = await tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: {
      approver: { select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } },
    } });
    return new Set(rows.filter(({ approver }) => approver.id !== subjectId && approver.role === "ADMIN"
      && approver.status === "ACTIVE" && approver.mfa?.enrollmentStatus === "ENABLED"
      && approver.mfa.enabledAt instanceof Date).map(({ approver }) => approver.id));
  };

  const startEnrollment = async ({ userId, secret, requestId } = {}) => {
    assertId(userId);
    const sealed = await encryption.encrypt(secret, { userId, purpose: "totp-pending" });
    const client = await get();
    const pendingExpiresAt = new Date(now().getTime() + 10 * 60_000);
    try {
      return await client.$transaction(async (tx) => {
        await lockUserRow(tx, userId);
        await lockMfaRow(tx, userId);
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
        await lockUserRow(tx, userId);
        await lockMfaRow(tx, userId);
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

  const createRecoveryCodeBatch = async ({ userId, sessionId, authVersion, mfaVerifiedAt } = {}) => {
    assertId(userId); assertId(sessionId);
    if (!Number.isSafeInteger(authVersion) || !(mfaVerifiedAt instanceof Date) || !Number.isFinite(mfaVerifiedAt.getTime())) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
    const { codes, batchId } = generateRecoveryBatch();
    const client = await get();
    try {
      await client.$transaction(async (tx) => {
        await lockUserRow(tx, userId);
        await lockMfaRow(tx, userId);
        await lockSessionRow(tx, sessionId);
        const [user, mfa, session] = await Promise.all([
          tx.user.findUnique({ where: { id: userId }, select: { status: true, authVersion: true } }),
          tx.userMfa.findUnique({ where: { userId }, select: { enrollmentStatus: true, enabledAt: true } }),
          tx.refreshToken.findUnique({ where: { id: sessionId }, select: { id: true, userId: true, authVersion: true, assuranceLevel: true, mfaVerifiedAt: true, createdAt: true, revokedAt: true, expiresAt: true } }),
        ]);
        const currentTime = now();
        if (!user || user.status !== "ACTIVE" || user.authVersion !== authVersion
          || mfa?.enrollmentStatus !== "ENABLED" || !(mfa.enabledAt instanceof Date)
          || !session || session.userId !== userId || session.authVersion !== authVersion
          || session.assuranceLevel !== "TOTP_VERIFIED" || !(session.mfaVerifiedAt instanceof Date)
          || Math.floor(session.mfaVerifiedAt.getTime() / 1000) !== Math.floor(mfaVerifiedAt.getTime() / 1000)
          || !(session.createdAt instanceof Date) || session.createdAt < mfa.enabledAt
          || session.revokedAt !== null || session.expiresAt <= currentTime) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await persistRecoveryBatch(tx, userId, codes, batchId);
      });
      return Object.freeze({ batchId, codes: Object.freeze(codes) });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const disableMfa = async ({ userId, sessionId, authVersion, requestId } = {}) => {
    assertId(userId); assertId(sessionId);
    if (!Number.isSafeInteger(authVersion)) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        await lockUserRow(tx, userId);
        await lockMfaRow(tx, userId);
        await lockSessionRow(tx, sessionId);
        const [user, mfa, session] = await Promise.all([
          tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true, authVersion: true } }),
          tx.userMfa.findUnique({ where: { userId }, select: { id: true, enrollmentStatus: true, enabledAt: true } }),
          tx.refreshToken.findUnique({ where: { id: sessionId }, select: { id: true, userId: true, authVersion: true, assuranceLevel: true, mfaVerifiedAt: true, createdAt: true, revokedAt: true, expiresAt: true } }),
        ]);
        const timestamp = now();
        if (!user || user.status !== "ACTIVE" || user.authVersion !== authVersion || user.role === "ADMIN"
          || !mfa || mfa.enrollmentStatus !== "ENABLED" || !(mfa.enabledAt instanceof Date)
          || !session || session.userId !== userId || session.authVersion !== authVersion
          || session.assuranceLevel !== "TOTP_VERIFIED" || !(session.mfaVerifiedAt instanceof Date)
          || !(session.createdAt instanceof Date) || session.createdAt < mfa.enabledAt
          || session.revokedAt !== null || session.expiresAt <= timestamp) {
          throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        }
        const changed = await tx.userMfa.updateMany({ where: { id: mfa.id, userId, enrollmentStatus: "ENABLED", enabledAt: mfa.enabledAt }, data: {
          enrollmentStatus: "DISABLED", secretCiphertext: null, secretNonce: null, secretAuthTag: null,
          secretKeyId: null, secretKeyVersion: null, enabledAt: null, lastAcceptedTimeStep: null,
          pendingCiphertext: null, pendingNonce: null, pendingAuthTag: null, pendingKeyId: null,
          pendingKeyVersion: null, pendingExpiresAt: null,
        } });
        if (changed.count !== 1) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await tx.mfaRecoveryCode.updateMany({ where: { userId, consumedAt: null, invalidatedAt: null }, data: { invalidatedAt: timestamp } });
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: timestamp, revocationReason: "mfa_disabled" } });
        const userChanged = await tx.user.updateMany({ where: { id: userId, status: "ACTIVE", authVersion }, data: { authVersion: { increment: 1 } } });
        if (userChanged.count !== 1) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await audit(tx, userId, "MFA_DISABLED", "UserMfa", mfa.id, requestId ? { requestId } : {});
        return { disabled: true };
      }, { isolationLevel: "Serializable" });
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
    const isTotpCode = typeof code === "string" && /^\d{6}$/.test(code);
    const isRecoveryCode = typeof code === "string" && /^[a-f\d]{32}$/i.test(code);
    if (typeof token !== "string" || !token || (!isTotpCode && !isRecoveryCode) || (isTotpCode && typeof verifyTotp !== "function")) return null;
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

        let assuranceLevel;
        let mfaVerifiedAt = null;
        if (isTotpCode) {
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
          assuranceLevel = "TOTP_VERIFIED";
          mfaVerifiedAt = now();
        } else {
          const codeClaim = await tx.mfaRecoveryCode.updateMany({
            where: { userId: user.id, codeHash: hash(normalizeCode(code)), consumedAt: null, invalidatedAt: null },
            data: { consumedAt: now() },
          });
          if (codeClaim.count !== 1) return recordFailure();
          assuranceLevel = "RECOVERY_CODE_VERIFIED";
          await audit(tx, user.id, "MFA_RECOVERY_CODE_CONSUMED", "User", user.id, { purpose: "LOGIN" });
        }

        const consumed = await tx.mfaChallenge.updateMany({ where: {
          id: challenge.id, purpose: "LOGIN", authVersion: challenge.authVersion,
          attemptCount: { equals: challenge.attemptCount }, consumedAt: null, expiresAt: { gt: now() },
          user: { status: "ACTIVE", authVersion: challenge.authVersion },
        }, data: { consumedAt: now() } });
        if (consumed.count !== 1) throw new MfaPersistenceError("MFA_CHALLENGE_INVALID");
        if (assuranceLevel === "TOTP_VERIFIED") await audit(tx, user.id, "MFA_LOGIN_VERIFIED", "MfaChallenge", challenge.id);
        return { userId: user.id, role: user.role, authVersion: user.authVersion, assuranceLevel, mfaVerifiedAt };
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

  const createAccountRecoveryRequest = async ({ userId, requestedByUserId = null, expiresAt, legacyAdminEnrollment = false } = {}) => {
    assertId(userId);
    if (!(expiresAt instanceof Date) || expiresAt <= now()) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    try {
      const client = await get();
      return await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } });
        if (!user || user.status !== "ACTIVE" || (legacyAdminEnrollment && (user.role !== "ADMIN" || (user.mfa?.enrollmentStatus === "ENABLED" && user.mfa.enabledAt instanceof Date)))) throw new MfaPersistenceError("MFA_ACCOUNT_UNAVAILABLE");
        await tx.accountRecoveryRequest.updateMany({ where: { userId, status: "PENDING", expiresAt: { lte: now() } }, data: { status: "EXPIRED", version: { increment: 1 } } });
        const existing = await tx.accountRecoveryRequest.findFirst({ where: { userId, status: "PENDING", expiresAt: { gt: now() } }, select: { id: true, status: true, expiresAt: true } });
        if (existing) return existing;
        const created = await tx.accountRecoveryRequest.create({ data: { userId, requestedByUserId, expiresAt }, select: { id: true, status: true, expiresAt: true } });
        await audit(tx, requestedByUserId, "ACCOUNT_RECOVERY_REQUEST_CREATED", "AccountRecoveryRequest", created.id, { subjectUserId: userId });
        return created;
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const createLegacyAdminEnrollmentRequest = async ({ userId, requestedByUserId, expiresAt } = {}) => createAccountRecoveryRequest({ userId, requestedByUserId, expiresAt, legacyAdminEnrollment: true });

  const verifyRecoveryIdentity = async ({ requestId, evidenceReference } = {}) => {
    assertId(requestId);
    if (typeof evidenceReference !== "string" || !evidenceReference || evidenceReference.length > 255 || typeof verifyIndependentIdentity !== "function") throw new MfaPersistenceError("MFA_IDENTITY_VERIFICATION_UNAVAILABLE");
    let verified = false;
    try { verified = await verifyIndependentIdentity({ requestId, evidenceReference }); } catch { verified = false; }
    if (!verified) throw new MfaPersistenceError("MFA_IDENTITY_VERIFICATION_FAILED");
    try {
      const client = await get();
      await client.$transaction(async (tx) => {
        const request = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true } });
        if (!request || request.status !== "PENDING" || request.identityVerifiedAt || request.expiresAt <= now()) throw new MfaPersistenceError("MFA_RECOVERY_REQUEST_UNAVAILABLE");
        const result = await tx.accountRecoveryRequest.updateMany({ where: { id: requestId, status: "PENDING", identityVerifiedAt: null, expiresAt: { gt: now() }, user: { is: { status: "ACTIVE" } } }, data: { identityVerifiedAt: now(), identityVerificationRef: evidenceReference, version: { increment: 1 } } });
        if (result.count !== 1) throw new MfaPersistenceError("MFA_RECOVERY_REQUEST_UNAVAILABLE");
        await audit(tx, null, "ACCOUNT_RECOVERY_IDENTITY_VERIFIED", "AccountRecoveryRequest", requestId, { subjectUserId: request.userId });
      }, { isolationLevel: "Serializable" });
      return true;
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError(); }
  };

  const recordRecoveryApproval = async ({ requestId, approverId, decision, reasonCode } = {}) => {
    assertId(requestId); assertId(approverId);
    if (!["APPROVE", "REJECT"].includes(decision) || (reasonCode !== undefined && reasonCode !== null && (typeof reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(reasonCode)))) throw new MfaPersistenceError("MFA_INVALID_INPUT");
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "account_recovery_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true, version: true } });
        const priorApprovalIds = request ? await tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: { approverId: true } }) : [];
        const lockIds = [...new Set([approverId, ...(request ? [request.userId] : []), ...priorApprovalIds.map(({ approverId: id }) => id)])].sort();
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "user_mfa" WHERE "user_id" = ${id}::uuid FOR UPDATE`;
        const approver = await tx.user.findUnique({ where: { id: approverId }, select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } });
        const subject = request ? await tx.user.findUnique({ where: { id: request.userId }, select: { status: true } }) : null;
        if (!approver || approver.role !== "ADMIN" || approver.status !== "ACTIVE" || approver.mfa?.enrollmentStatus !== "ENABLED" || !(approver.mfa.enabledAt instanceof Date) || !request || !subject || subject.status !== "ACTIVE" || request.status !== "PENDING" || !request.identityVerifiedAt || request.expiresAt <= now() || request.userId === approverId) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        const approval = await tx.recoveryApproval.create({ data: { requestId, approverId, decision, reasonCode }, select: { id: true } });
        let nextStatus = request.status;
        if (decision === "REJECT") nextStatus = "REJECTED";
        else {
          const approvals = await tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: { approver: { select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } } } });
          const eligible = new Set(approvals.filter((entry) => entry.approver.role === "ADMIN" && entry.approver.status === "ACTIVE" && entry.approver.mfa?.enrollmentStatus === "ENABLED" && entry.approver.mfa.enabledAt instanceof Date).map((entry) => entry.approver.id));
          if (eligible.size >= 2) nextStatus = "APPROVED";
        }
        const updated = await tx.accountRecoveryRequest.updateMany({ where: { id: requestId, status: "PENDING", version: request.version }, data: { status: nextStatus, version: { increment: 1 } } });
        if (updated.count !== 1) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
        await audit(tx, approverId, "ACCOUNT_RECOVERY_APPROVAL_RECORDED", "AccountRecoveryRequest", requestId, { decision, status: nextStatus, approvalId: approval.id, reasonCode: reasonCode ?? null });
        return { status: nextStatus };
      });
    } catch (error) {
      if (error instanceof MfaPersistenceError) throw error;
      // Unique conflict means this approver already decided; never expose Prisma details.
      throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
    }
  };

  const completeAccountRecovery = async ({ requestId, completedByUserId } = {}) => {
    assertId(requestId); assertId(completedByUserId);
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "account_recovery_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true, version: true } });
        if (!request || request.status !== "APPROVED" || !request.identityVerifiedAt || request.expiresAt <= now()) throw new MfaPersistenceError("MFA_RECOVERY_REQUEST_UNAVAILABLE");
        if (request.userId === completedByUserId) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        const approvalIds = await tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: { approverId: true } });
        const lockIds = [...new Set([completedByUserId, request.userId, ...approvalIds.map(({ approverId }) => approverId)])].sort();
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "user_mfa" WHERE "user_id" = ${id}::uuid FOR UPDATE`;
        const [operator, subject, approvals] = await Promise.all([
          tx.user.findUnique({ where: { id: completedByUserId }, select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } }),
          tx.user.findUnique({ where: { id: request.userId }, select: { id: true, role: true, status: true, authVersion: true, mfa: { select: { id: true, enrollmentStatus: true, enabledAt: true } } } }),
          tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: { approver: { select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } } } }),
        ]);
        const eligibleApprovers = new Set(approvals.filter(({ approver }) => approver.role === "ADMIN" && approver.status === "ACTIVE" && approver.mfa?.enrollmentStatus === "ENABLED" && approver.mfa.enabledAt instanceof Date && approver.id !== request.userId).map(({ approver }) => approver.id));
        if (!operator || operator.role !== "ADMIN" || operator.status !== "ACTIVE" || operator.mfa?.enrollmentStatus !== "ENABLED" || !(operator.mfa.enabledAt instanceof Date)
          || !subject || subject.status !== "ACTIVE" || subject.role === "ADMIN" || eligibleApprovers.size < 2) {
          throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        }
        const timestamp = now();
        if (subject.mfa) await tx.userMfa.updateMany({ where: { id: subject.mfa.id, userId: subject.id }, data: {
          enrollmentStatus: "DISABLED", secretCiphertext: null, secretNonce: null, secretAuthTag: null,
          secretKeyId: null, secretKeyVersion: null, enabledAt: null, lastAcceptedTimeStep: null,
          pendingCiphertext: null, pendingNonce: null, pendingAuthTag: null, pendingKeyId: null,
          pendingKeyVersion: null, pendingExpiresAt: null,
        } });
        await tx.mfaRecoveryCode.updateMany({ where: { userId: subject.id, consumedAt: null, invalidatedAt: null }, data: { invalidatedAt: timestamp } });
        await tx.refreshToken.updateMany({ where: { userId: subject.id, revokedAt: null }, data: { revokedAt: timestamp, revocationReason: "account_recovery" } });
        const userChanged = await tx.user.updateMany({ where: { id: subject.id, status: "ACTIVE", authVersion: subject.authVersion }, data: { authVersion: { increment: 1 } } });
        const requestChanged = await tx.accountRecoveryRequest.updateMany({ where: { id: requestId, status: "APPROVED", version: request.version, expiresAt: { gt: timestamp } }, data: { status: "COMPLETED", completedAt: timestamp, version: { increment: 1 } } });
        if (userChanged.count !== 1 || requestChanged.count !== 1) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
        await audit(tx, completedByUserId, "ACCOUNT_RECOVERY_COMPLETED", "AccountRecoveryRequest", requestId, { subjectUserId: subject.id, approverCount: eligibleApprovers.size });
        return { status: "COMPLETED", mfaReset: true };
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT"); }
  };

  // Legacy ADMIN onboarding reuses the durable recovery approval records and
  // MfaChallenge token hash. The raw authorization is delivered only through
  // an explicitly configured out-of-band provider; it is never returned by an
  // administrative API response or stored in PostgreSQL.
  const issueLegacyAdminEnrollmentAuthorization = async ({ requestId, issuedByUserId } = {}) => {
    assertId(requestId); assertId(issuedByUserId);
    if (typeof deliverLegacyAdminEnrollmentAuthorization !== "function") throw new MfaPersistenceError("MFA_ENROLLMENT_DELIVERY_UNAVAILABLE");
    const token = makeChallenge();
    const expiresAt = new Date(now().getTime() + 10 * 60_000);
    const client = await get();
    let target;
    let challengeId;
    try {
      ({ target, challengeId } = await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "account_recovery_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const request = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId }, select: {
          id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true,
        } });
        if (!request || request.status !== "APPROVED" || !request.identityVerifiedAt || request.expiresAt <= now()) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        const approvalIds = await tx.recoveryApproval.findMany({ where: { requestId, decision: "APPROVE" }, select: { approverId: true } });
        const lockIds = [...new Set([issuedByUserId, request.userId, ...approvalIds.map(({ approverId }) => approverId)])].sort();
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "user_mfa" WHERE "user_id" = ${id}::uuid FOR UPDATE`;
        const [operator, subject] = await Promise.all([
          tx.user.findUnique({ where: { id: issuedByUserId }, select: { id: true, role: true, status: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } }),
          tx.user.findUnique({ where: { id: request.userId }, select: { id: true, email: true, role: true, status: true, authVersion: true, mfa: { select: { enrollmentStatus: true, enabledAt: true, pendingExpiresAt: true } } } }),
        ]);
        const approvers = await eligibleRecoveryApprovers(tx, requestId, request.userId);
        if (!operator || operator.role !== "ADMIN" || operator.status !== "ACTIVE" || operator.mfa?.enrollmentStatus !== "ENABLED" || !(operator.mfa.enabledAt instanceof Date)
          || !subject || subject.role !== "ADMIN" || subject.status !== "ACTIVE" || (subject.mfa?.enrollmentStatus === "ENABLED" && subject.mfa.enabledAt instanceof Date)
          || (subject.mfa?.enrollmentStatus === "PENDING" && subject.mfa.pendingExpiresAt > now())
          || approvers.size < 2) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_DENIED");
        const timestamp = now();
        const outstanding = await tx.mfaChallenge.findFirst({ where: { userId: subject.id, purpose: "LEGACY_ADMIN_MFA_ENROLL", consumedAt: null, expiresAt: { gt: timestamp } }, select: { id: true } });
        if (outstanding) throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT");
        await tx.mfaChallenge.updateMany({ where: { userId: subject.id, purpose: { in: ["LEGACY_ADMIN_MFA_ENROLL", "LEGACY_ADMIN_MFA_VERIFY"] }, consumedAt: null, expiresAt: { gt: timestamp } }, data: { expiresAt: timestamp } });
        const challenge = await tx.mfaChallenge.create({ data: {
          userId: subject.id, tokenHash: hash(token), purpose: "LEGACY_ADMIN_MFA_ENROLL", authVersion: subject.authVersion, expiresAt,
        }, select: { id: true } });
        await audit(tx, issuedByUserId, "LEGACY_ADMIN_MFA_AUTHORIZATION_ISSUED", "AccountRecoveryRequest", requestId, { subjectUserId: subject.id, expiresAt: expiresAt.toISOString() });
        return { target: { id: subject.id, email: subject.email }, challengeId: challenge.id };
      }, { isolationLevel: "Serializable" }));
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError("MFA_RECOVERY_APPROVAL_CONFLICT"); }
    try {
      await deliverLegacyAdminEnrollmentAuthorization({ userId: target.id, email: target.email, authorizationToken: token, expiresAt });
      return Object.freeze({ issued: true, expiresAt });
    } catch {
      await client.mfaChallenge.updateMany({ where: { id: challengeId, consumedAt: null }, data: { expiresAt: now() } }).catch(() => {});
      throw new MfaPersistenceError("MFA_ENROLLMENT_DELIVERY_UNAVAILABLE");
    }
  };

  const startLegacyAdminEnrollment = async ({ token, secret } = {}) => {
    if (typeof token !== "string" || !token || typeof secret !== "string" || !secret) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
    const client = await get();
    let enrollmentOwner;
    try { enrollmentOwner = await client.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: { userId: true, purpose: true, consumedAt: true, verifiedAt: true, expiresAt: true } }); }
    catch { throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE"); }
    if (!enrollmentOwner || enrollmentOwner.purpose !== "LEGACY_ADMIN_MFA_ENROLL" || enrollmentOwner.consumedAt || enrollmentOwner.verifiedAt || enrollmentOwner.expiresAt <= now()) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
    const sealed = await encryption.encrypt(secret, { userId: enrollmentOwner.userId, purpose: "totp-pending" });
    try {
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: { id: true, userId: true, purpose: true, authVersion: true, expiresAt: true, consumedAt: true, verifiedAt: true } });
        if (!challenge || challenge.purpose !== "LEGACY_ADMIN_MFA_ENROLL"
          || challenge.consumedAt || challenge.verifiedAt || challenge.expiresAt <= now()) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const requestRef = await tx.accountRecoveryRequest.findFirst({ where: { userId: challenge.userId, status: "APPROVED", identityVerifiedAt: { not: null }, expiresAt: { gt: now() } }, orderBy: { createdAt: "desc" }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true } });
        if (!requestRef) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        await tx.$queryRaw`SELECT "id" FROM "account_recovery_requests" WHERE "id" = ${requestRef.id}::uuid FOR UPDATE`;
        await lockUserRow(tx, challenge.userId);
        await lockMfaRow(tx, challenge.userId);
        await tx.$queryRaw`SELECT "id" FROM "mfa_challenges" WHERE "id" = ${challenge.id}::uuid FOR UPDATE`;
        const [user, request, mfa] = await Promise.all([
          tx.user.findUnique({ where: { id: challenge.userId }, select: { id: true, email: true, role: true, status: true, authVersion: true } }),
          tx.accountRecoveryRequest.findUnique({ where: { id: requestRef.id }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true } }),
          tx.userMfa.findUnique({ where: { userId: challenge.userId }, select: { id: true, enrollmentStatus: true, enabledAt: true, pendingExpiresAt: true } }),
        ]);
        if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE" || user.authVersion !== challenge.authVersion || !request || request.userId !== user.id || request.status !== "APPROVED" || !request.identityVerifiedAt || request.expiresAt <= now()
          || (mfa?.enrollmentStatus === "ENABLED" && mfa.enabledAt instanceof Date)
          || (mfa?.enrollmentStatus === "PENDING" && mfa.pendingExpiresAt > now())) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const approvals = await eligibleRecoveryApprovers(tx, request.id, user.id);
        if (approvals.size < 2) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const pendingExpiresAt = new Date(Math.min(challenge.expiresAt.getTime(), now().getTime() + 10 * 60_000));
        const data = { enrollmentStatus: "PENDING", pendingCiphertext: sealed.ciphertext, pendingNonce: sealed.nonce, pendingAuthTag: sealed.authTag, pendingKeyId: sealed.keyId, pendingKeyVersion: sealed.keyVersion, pendingExpiresAt };
        const record = mfa
          ? await tx.userMfa.update({ where: { id: mfa.id }, data, select: { id: true } })
          : await tx.userMfa.create({ data: { userId: user.id, ...data }, select: { id: true } });
        const claimed = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, userId: user.id, purpose: "LEGACY_ADMIN_MFA_ENROLL", consumedAt: null, expiresAt: { gt: now() }, authVersion: user.authVersion }, data: { consumedAt: now() } });
        if (claimed.count !== 1) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const verificationToken = makeChallenge();
        await tx.mfaChallenge.create({ data: { userId: user.id, tokenHash: hash(verificationToken), purpose: "LEGACY_ADMIN_MFA_VERIFY", authVersion: user.authVersion, expiresAt: pendingExpiresAt }, select: { id: true } });
        await audit(tx, null, "LEGACY_ADMIN_MFA_ENROLLMENT_STARTED", "AccountRecoveryRequest", request.id, { subjectUserId: user.id });
        return { enrollmentId: record.id, expiresAt: pendingExpiresAt, email: user.email, verificationToken };
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE"); }
  };

  const activateLegacyAdminEnrollment = async ({ token, code } = {}) => {
    if (typeof token !== "string" || !token || typeof code !== "string" || !/^\d{6}$/.test(code) || typeof verifyTotp !== "function") throw new MfaPersistenceError("MFA_VERIFICATION_FAILED");
    const recoveryBatch = generateRecoveryBatch();
    const client = await get();
    try {
      return await client.$transaction(async (tx) => {
        const challenge = await tx.mfaChallenge.findUnique({ where: { tokenHash: hash(token) }, select: { id: true, userId: true, purpose: true, authVersion: true, expiresAt: true, consumedAt: true, verifiedAt: true } });
        if (!challenge || challenge.purpose !== "LEGACY_ADMIN_MFA_VERIFY"
          || challenge.consumedAt || challenge.expiresAt <= now()) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const requestRef = await tx.accountRecoveryRequest.findFirst({ where: { userId: challenge.userId, status: "APPROVED", identityVerifiedAt: { not: null }, expiresAt: { gt: now() } }, orderBy: { createdAt: "desc" }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true } });
        if (!requestRef) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        await tx.$queryRaw`SELECT "id" FROM "account_recovery_requests" WHERE "id" = ${requestRef.id}::uuid FOR UPDATE`;
        const approvalsBeforeLock = await tx.recoveryApproval.findMany({ where: { requestId: requestRef.id, decision: "APPROVE" }, select: { approverId: true } });
        const lockIds = [...new Set([challenge.userId, ...approvalsBeforeLock.map(({ approverId }) => approverId)])].sort();
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
        for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "user_mfa" WHERE "user_id" = ${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "mfa_challenges" WHERE "id" = ${challenge.id}::uuid FOR UPDATE`;
        const [user, mfa, request, challengeCurrent] = await Promise.all([
          tx.user.findUnique({ where: { id: challenge.userId }, select: { id: true, role: true, status: true, authVersion: true } }),
          tx.userMfa.findUnique({ where: { userId: challenge.userId } }),
          tx.accountRecoveryRequest.findUnique({ where: { id: requestRef.id }, select: { id: true, userId: true, status: true, identityVerifiedAt: true, expiresAt: true } }),
          tx.mfaChallenge.findUnique({ where: { id: challenge.id }, select: { consumedAt: true, verifiedAt: true, expiresAt: true, authVersion: true } }),
        ]);
        const approvers = await eligibleRecoveryApprovers(tx, requestRef.id, challenge.userId);
        if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE" || user.authVersion !== challenge.authVersion || !request || request.userId !== user.id || request.status !== "APPROVED" || !request.identityVerifiedAt || request.expiresAt <= now()
          || !mfa || mfa.enrollmentStatus !== "PENDING" || !mfa.pendingCiphertext || !mfa.pendingExpiresAt || mfa.pendingExpiresAt <= now()
          || !challengeCurrent || challengeCurrent.consumedAt || challengeCurrent.expiresAt <= now() || challengeCurrent.authVersion !== user.authVersion || approvers.size < 2) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        const secret = await encryption.decrypt({ ciphertext: mfa.pendingCiphertext, nonce: mfa.pendingNonce, authTag: mfa.pendingAuthTag, keyId: mfa.pendingKeyId, keyVersion: mfa.pendingKeyVersion }, { userId: user.id, purpose: "totp-pending" });
        const result = await verifyTotp(secret, code, { stepSeconds: 30, digits: 6, window: totpWindowSteps, at: now() });
        if (!result?.valid || !Number.isSafeInteger(result.timeStep)) throw new MfaPersistenceError("MFA_VERIFICATION_FAILED");
        const enabledAt = now();
        const activated = await tx.userMfa.updateMany({ where: { id: mfa.id, userId: user.id, enrollmentStatus: "PENDING", pendingExpiresAt: { gt: enabledAt } }, data: {
          enrollmentStatus: "ENABLED", secretCiphertext: mfa.pendingCiphertext, secretNonce: mfa.pendingNonce, secretAuthTag: mfa.pendingAuthTag, secretKeyId: mfa.pendingKeyId, secretKeyVersion: mfa.pendingKeyVersion,
          enabledAt, lastAcceptedTimeStep: BigInt(result.timeStep), pendingCiphertext: null, pendingNonce: null, pendingAuthTag: null, pendingKeyId: null, pendingKeyVersion: null, pendingExpiresAt: null,
        } });
        const consumed = await tx.mfaChallenge.updateMany({ where: { id: challenge.id, userId: user.id, purpose: "LEGACY_ADMIN_MFA_VERIFY", authVersion: user.authVersion, consumedAt: null, expiresAt: { gt: enabledAt } }, data: { consumedAt: enabledAt } });
        if (activated.count !== 1 || consumed.count !== 1) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        await tx.mfaChallenge.updateMany({ where: { userId: user.id, id: { not: challenge.id }, expiresAt: { gt: enabledAt } }, data: { expiresAt: enabledAt } });
        await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: enabledAt, revocationReason: "mfa_reenrollment" } });
        const changedUser = await tx.user.updateMany({ where: { id: user.id, role: "ADMIN", status: "ACTIVE", authVersion: user.authVersion }, data: { authVersion: { increment: 1 } } });
        if (changedUser.count !== 1) throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE");
        await persistRecoveryBatch(tx, user.id, recoveryBatch.codes, recoveryBatch.batchId);
        await audit(tx, null, "LEGACY_ADMIN_MFA_ENROLLMENT_COMPLETED", "AccountRecoveryRequest", request.id, { subjectUserId: user.id, previousSessionsRevoked: true });
        return { enabled: true, codes: Object.freeze(recoveryBatch.codes) };
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof MfaPersistenceError) throw error; throw new MfaPersistenceError("MFA_ENROLLMENT_UNAVAILABLE"); }
  };

  return Object.freeze({ startEnrollment, activateEnrollment, activateEnrollmentAndIssueRecoveryCodes, advanceTimeStep, createRecoveryCodeBatch, disableMfa, consumeRecoveryCode, createChallenge, createStepUpChallenge, completeStepUpChallenge, completeLoginChallenge, recordChallengeFailure, consumeChallenge, createAccountRecoveryRequest, createLegacyAdminEnrollmentRequest, verifyRecoveryIdentity, recordRecoveryApproval, completeAccountRecovery, issueLegacyAdminEnrollmentAuthorization, startLegacyAdminEnrollment, activateLegacyAdminEnrollment });
};
