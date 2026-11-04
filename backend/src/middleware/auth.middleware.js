import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { MFA_ASSURANCE_LEVELS, verifyAccessToken } from "../utils/jwt.js";

const authenticationRequired = () => new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
const verifiedContext = Symbol("trustbridge.verifiedAuthContext");

export const createAuthenticationMiddleware = ({
  getClient = getPrismaClient,
  verify = verifyAccessToken,
  now = () => new Date(),
} = {}) => async (request, _response, next) => {
  if (request[verifiedContext] && request.auth) return next();
  const header = request.get("authorization");
  const match = typeof header === "string" && /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return next(authenticationRequired());
  let claims;
  try { claims = verify(match[1]); } catch { return next(authenticationRequired()); }
  if (!claims || typeof claims.userId !== "string" || !claims.userId) return next(authenticationRequired());
  try {
    const prisma = await getClient();
    const user = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, role: true, status: true, authVersion: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } },
    });
    if (!user || user.status !== "ACTIVE" || !MFA_ASSURANCE_LEVELS.includes(claims.assuranceLevel) || typeof claims.sessionId !== "string") return next(authenticationRequired());
    const authVersion = Number.isSafeInteger(user.authVersion) ? user.authVersion : 0;
    if (claims.authVersion !== authVersion) return next(authenticationRequired());
    if (typeof prisma.refreshToken?.findUnique !== "function") return next(authenticationRequired());
    const session = await prisma.refreshToken.findUnique({ where: { id: claims.sessionId }, select: { userId: true, authVersion: true, assuranceLevel: true, mfaVerifiedAt: true, createdAt: true, revokedAt: true, expiresAt: true } });
    const nowValue = now();
    const mfaEnabled = user.mfa?.enrollmentStatus === "ENABLED" && user.mfa.enabledAt instanceof Date;
    if (!session || session.revokedAt || !(session.expiresAt instanceof Date) || session.expiresAt <= nowValue
      || session.userId !== user.id || session.authVersion !== authVersion || session.assuranceLevel !== claims.assuranceLevel
      || !MFA_ASSURANCE_LEVELS.includes(session.assuranceLevel)) return next(authenticationRequired());
    const isTotp = session.assuranceLevel === "TOTP_VERIFIED";
    const hasMfa = isTotp || session.assuranceLevel === "RECOVERY_CODE_VERIFIED";
    const timestampMatches = isTotp && session.mfaVerifiedAt instanceof Date && claims.mfaVerifiedAt instanceof Date
      ? Math.floor(session.mfaVerifiedAt.getTime() / 1000) === Math.floor(claims.mfaVerifiedAt.getTime() / 1000)
      : !isTotp && session.mfaVerifiedAt === null && claims.mfaVerifiedAt === null;
    if (!timestampMatches || (hasMfa && (!mfaEnabled || !(session.createdAt instanceof Date) || session.createdAt < user.mfa.enabledAt))
      || ((user.role === "ADMIN" || mfaEnabled) && (!mfaEnabled || !hasMfa))) return next(authenticationRequired());
    const mfaVerifiedAt = isTotp ? session.mfaVerifiedAt : null;
    request.auth = Object.freeze({ userId: user.id, role: user.role, authVersion, mfaEnabled, mfaVerifiedAt, assuranceLevel: session.assuranceLevel, sessionId: claims.sessionId });
    request[verifiedContext] = true;
    return next();
  } catch (error) { return next(error); }
};

export const requireAuthentication = createAuthenticationMiddleware();
