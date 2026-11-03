import jwt from "jsonwebtoken";
import { getEnv } from "../config/env.js";

export class InvalidAccessTokenError extends Error {
  constructor() {
    super("Access token is invalid");
    this.name = "InvalidAccessTokenError";
  }
}

export const signAccessToken = (userId, { environment = getEnv(), authVersion = 0, sessionId, mfaVerifiedAt } = {}) => {
  if (typeof userId !== "string" || userId.length === 0) throw new TypeError("Invalid subject");
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new TypeError("Invalid authorization version");
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) throw new TypeError("Invalid session identifier");
  if (mfaVerifiedAt !== undefined && (!(mfaVerifiedAt instanceof Date) || !Number.isFinite(mfaVerifiedAt.getTime()))) throw new TypeError("Invalid MFA assurance timestamp");
  const { accessSecret, accessTtl, algorithm, issuer, audience } = environment.jwt;
  const claims = { av: authVersion };
  if (sessionId) claims.sid = sessionId;
  if (mfaVerifiedAt) claims.mfa_at = Math.floor(mfaVerifiedAt.getTime() / 1000);
  return jwt.sign(claims, accessSecret, {
    algorithm,
    subject: userId,
    expiresIn: accessTtl,
    issuer,
    audience,
  });
};

export const verifyAccessToken = (token, { environment = getEnv(), now = () => new Date() } = {}) => {
  if (typeof token !== "string" || token.length > 8192) throw new InvalidAccessTokenError();
  try {
    const { accessSecret, algorithm, issuer, audience } = environment.jwt;
    const payload = jwt.verify(token, accessSecret, {
      algorithms: [algorithm], issuer, audience,
    });
    if (typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub) {
      throw new InvalidAccessTokenError();
    }
    const authVersion = payload.av === undefined ? 0 : payload.av;
    if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new InvalidAccessTokenError();
    const sessionId = payload.sid;
    if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)) throw new InvalidAccessTokenError();
    const mfaAtSeconds = payload.mfa_at;
    if (mfaAtSeconds !== undefined) {
      const currentTime = now();
      if (!Number.isSafeInteger(mfaAtSeconds) || mfaAtSeconds <= 0 || !(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime()) || mfaAtSeconds > Math.floor(currentTime.getTime() / 1000)) throw new InvalidAccessTokenError();
      if (!sessionId) throw new InvalidAccessTokenError();
    }
    return Object.freeze({
      userId: payload.sub,
      authVersion,
      sessionId: sessionId ?? null,
      mfaVerifiedAt: mfaAtSeconds === undefined ? null : new Date(mfaAtSeconds * 1000),
    });
  } catch {
    throw new InvalidAccessTokenError();
  }
};
