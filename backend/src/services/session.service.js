import { randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { getEnv } from "../config/env.js";
import { AuthServiceError } from "../utils/ApiError.js";
import { createRefreshToken, hashRefreshToken } from "../utils/refresh-token.js";
import { MFA_ASSURANCE_LEVELS, signAccessToken } from "../utils/jwt.js";

const invalidRefresh = () => new AuthServiceError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
const parseDuration = (value) => {
  const [, number, unit] = /^([1-9]\d{0,3})(s|m|h|d|w)$/.exec(value) ?? [];
  const seconds = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
  if (!number || !seconds) throw new TypeError("Invalid configured token duration");
  return Number(number) * seconds * 1000;
};

export const createSessionService = ({
  getClient = getPrismaClient,
  environment,
  makeToken = createRefreshToken,
  hashToken = hashRefreshToken,
  signAccess,
  now = () => new Date(),
  makeId = randomUUID,
} = {}) => {
  const config = () => environment ?? getEnv();
  const sign = signAccess ?? ((id, claims = {}) => signAccessToken(id, { environment: config(), ...claims }));
  const expiry = () => new Date(now().getTime() + parseDuration(config().jwt.refreshTtl));
  const issueAccess = (id, sessionClaims) => sign(id, sessionClaims);
  const issueForUser = async (userId, { mfaVerifiedAt = null, assuranceLevel, expectedAuthVersion } = {}) => {
    const client = await getClient();
    const user = await client.user.findUnique({ where: { id: userId }, select: {
      id: true, role: true, status: true, authVersion: true,
      mfa: { select: { enrollmentStatus: true, enabledAt: true } },
    } });
    const mfaEnabled = user?.mfa?.enrollmentStatus === "ENABLED" && Boolean(user.mfa.enabledAt);
    const needsMfa = user?.role === "ADMIN" || mfaEnabled;
    const validMfaTimestamp = mfaVerifiedAt instanceof Date && Number.isFinite(mfaVerifiedAt.getTime()) && mfaVerifiedAt <= now();
    const resolvedAssurance = assuranceLevel ?? (validMfaTimestamp ? "TOTP_VERIFIED" : "PASSWORD_ONLY");
    const assuranceValid = MFA_ASSURANCE_LEVELS.includes(resolvedAssurance)
      && ((resolvedAssurance === "TOTP_VERIFIED") === Boolean(validMfaTimestamp));
    const eligibleMfaAssurance = resolvedAssurance === "TOTP_VERIFIED" || resolvedAssurance === "RECOVERY_CODE_VERIFIED";
    if (!user || user.status !== "ACTIVE" || !Number.isSafeInteger(user.authVersion) || (expectedAuthVersion !== undefined && user.authVersion !== expectedAuthVersion) || !assuranceValid
      || (mfaVerifiedAt !== null && !validMfaTimestamp)
      || (needsMfa && (!mfaEnabled || !eligibleMfaAssurance)) || (eligibleMfaAssurance && !mfaEnabled)) {
      throw new AuthServiceError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    const token = makeToken();
    const tokenHash = hashToken(token);
    if (!tokenHash) throw new Error("Refresh token generator failed");
    const session = await client.refreshToken.create({ data: {
      userId, tokenHash, familyId: makeId(), authVersion: user.authVersion,
      mfaVerifiedAt: validMfaTimestamp ? mfaVerifiedAt : null,
      assuranceLevel: resolvedAssurance,
      expiresAt: expiry(),
    }, select: { id: true, createdAt: true } });
    return {
      accessToken: issueAccess(userId, { sessionId: session.id, authVersion: user.authVersion, mfaVerifiedAt: validMfaTimestamp ? mfaVerifiedAt : undefined, assuranceLevel: resolvedAssurance }),
      refreshToken: token,
      tokenType: "Bearer",
    };
  };

  const refresh = async (token) => {
    const tokenHash = hashToken(token);
    if (!tokenHash) throw invalidRefresh();
    const nextToken = makeToken();
    const nextHash = hashToken(nextToken);
    if (!nextHash) throw new Error("Refresh token generator failed");
    const client = await getClient();
    const result = await client.$transaction(async (tx) => {
      const current = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, familyId: true, authVersion: true, mfaVerifiedAt: true, assuranceLevel: true, createdAt: true, expiresAt: true, revokedAt: true, rotatedTo: { select: { id: true } }, user: { select: { status: true, role: true, authVersion: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } } },
      });
      if (!current) return { invalid: true };
      const detectReuse = async () => {
        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: now(), revocationReason: "refresh_reuse" },
        });
        await tx.refreshToken.updateMany({
          where: { id: current.id, reuseDetectedAt: null },
          data: { reuseDetectedAt: now() },
        });
        return { invalid: true };
      };
      if (current.revokedAt) return current.rotatedTo ? detectReuse() : { invalid: true };
      const mfaEnabled = current.user.mfa?.enrollmentStatus === "ENABLED" && Boolean(current.user.mfa.enabledAt);
      const needsMfa = current.user.role === "ADMIN" || mfaEnabled;
      const assuranceLevel = current.assuranceLevel;
      const validAssurance = MFA_ASSURANCE_LEVELS.includes(assuranceLevel)
        && ((assuranceLevel === "TOTP_VERIFIED") === Boolean(current.mfaVerifiedAt));
      const hasMfaAssurance = assuranceLevel === "TOTP_VERIFIED" || assuranceLevel === "RECOVERY_CODE_VERIFIED";
      if (current.expiresAt <= now() || current.user.status !== "ACTIVE" || current.authVersion !== current.user.authVersion || !validAssurance
        || (needsMfa && (!mfaEnabled || !hasMfaAssurance)) || (hasMfaAssurance && (!mfaEnabled || !(current.createdAt instanceof Date) || current.createdAt < current.user.mfa.enabledAt))) return { invalid: true };

      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null, expiresAt: { gt: now() } },
        data: { revokedAt: now(), revocationReason: "rotated", lastUsedAt: now() },
      });
      if (claimed.count !== 1) {
        const latest = await tx.refreshToken.findUnique({ where: { id: current.id }, select: { rotatedTo: { select: { id: true } } } });
        return latest?.rotatedTo ? detectReuse() : { invalid: true };
      }
      const replacement = await tx.refreshToken.create({ data: {
        userId: current.userId,
        tokenHash: nextHash,
        familyId: current.familyId,
        authVersion: current.authVersion,
        mfaVerifiedAt: current.mfaVerifiedAt,
        assuranceLevel,
        rotatedFromId: current.id,
        expiresAt: expiry(),
      }, select: { id: true } });
      return { userId: current.userId, replacementId: replacement.id, authVersion: current.authVersion, mfaVerifiedAt: current.mfaVerifiedAt, assuranceLevel };
    });
    if (result.invalid) throw invalidRefresh();
    return { accessToken: issueAccess(result.userId, { sessionId: result.replacementId, authVersion: result.authVersion, mfaVerifiedAt: result.mfaVerifiedAt ?? undefined, assuranceLevel: result.assuranceLevel }), refreshToken: nextToken, tokenType: "Bearer" };
  };

  const logout = async (token) => {
    const tokenHash = hashToken(token);
    if (!tokenHash) return;
    const client = await getClient();
    await client.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now(), revocationReason: "logout", lastUsedAt: now() },
    });
  };

  // The caller must supply the user ID from a server-verified access session;
  // this operation never accepts an account identifier from request data.
  const logoutAll = async (userId) => {
    if (typeof userId !== "string" || !userId) throw new TypeError("Authenticated user ID is required");
    const client = await getClient();
    const result = await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now(), revocationReason: "logout_all", lastUsedAt: now() },
    });
    return { revokedCount: result.count };
  };

  return Object.freeze({ issueForUser, refresh, logout, logoutAll });
};
