import { createHash, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const createRefreshToken = () => randomBytes(32).toString("base64url");

export const hashRefreshToken = (token) => {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token) return null;
  return createHash("sha256").update(bytes).digest("hex");
};
