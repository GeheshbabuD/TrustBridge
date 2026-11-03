import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { verifyAccessToken } from "../utils/jwt.js";

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
    if (!user || user.status !== "ACTIVE") return next(authenticationRequired());
    const authVersion = Number.isSafeInteger(user.authVersion) ? user.authVersion : 0;
    if (claims.authVersion !== authVersion) return next(authenticationRequired());
    const mfaEnabled = user.mfa?.enrollmentStatus === "ENABLED" && Boolean(user.mfa.enabledAt);
    let mfaVerifiedAt = claims.mfaVerifiedAt;
    if (mfaVerifiedAt) {
      if (!claims.sessionId || typeof prisma.refreshToken?.findUnique !== "function") return next(authenticationRequired());
      const session = await prisma.refreshToken.findUnique({ where: { id: claims.sessionId }, select: { userId: true, authVersion: true, mfaVerifiedAt: true, revokedAt: true, expiresAt: true } });
      if (!session || session.revokedAt || !(session.expiresAt instanceof Date) || session.expiresAt <= now() || session.userId !== user.id || session.authVersion !== authVersion || !session.mfaVerifiedAt || Math.floor(session.mfaVerifiedAt.getTime() / 1000) !== Math.floor(mfaVerifiedAt.getTime() / 1000)) return next(authenticationRequired());
    }
    if ((user.role === "ADMIN" || mfaEnabled) && (!mfaEnabled || !mfaVerifiedAt)) return next(authenticationRequired());
    request.auth = Object.freeze({ userId: user.id, role: user.role, authVersion, mfaEnabled, mfaVerifiedAt: mfaVerifiedAt ?? null, sessionId: claims.sessionId ?? null });
    request[verifiedContext] = true;
    return next();
  } catch (error) { return next(error); }
};

export const requireAuthentication = createAuthenticationMiddleware();
