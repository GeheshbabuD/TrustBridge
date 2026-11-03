import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { validateEnv } from "../../src/config/env.js";
import { signAccessToken, verifyAccessToken } from "../../src/utils/jwt.js";

const environment = validateEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/trustbridge_test",
  JWT_ACCESS_SECRET: "synthetic-access-secret-with-over-32-characters",
  JWT_REFRESH_SECRET: "synthetic-refresh-secret-with-over-32-characters",
  JWT_ACCESS_TTL: "15m",
  JWT_ISSUER: "tb-tests",
  JWT_AUDIENCE: "tb-client-tests",
});

test("access JWT uses minimal claims and verifies configured issuer and audience", () => {
  const token = signAccessToken("user-123", { environment });
  assert.deepEqual(verifyAccessToken(token, { environment }), { userId: "user-123", authVersion: 0, sessionId: null, mfaVerifiedAt: null });
});

test("MFA assurance claims are backend signed, session bound and time validated", () => {
  const mfaVerifiedAt = new Date(Date.now() - 30_000);
  const token = signAccessToken("user-123", { environment, authVersion: 4, sessionId: "session-1", mfaVerifiedAt });
  const claims = verifyAccessToken(token, { environment });
  assert.equal(claims.authVersion, 4);
  assert.equal(claims.sessionId, "session-1");
  assert.equal(Math.floor(claims.mfaVerifiedAt.getTime() / 1000), Math.floor(mfaVerifiedAt.getTime() / 1000));

  const orphaned = jwt.sign({ sub: "user-1", av: 0, mfa_at: Math.floor(Date.now() / 1000) }, environment.jwt.accessSecret, {
    algorithm: "HS256", issuer: environment.jwt.issuer, audience: environment.jwt.audience, expiresIn: "1m",
  });
  assert.throws(() => verifyAccessToken(orphaned, { environment }));
});

test("an opaque MFA challenge token is not an access JWT", () => {
  const challengeToken = Buffer.alloc(32, 7).toString("base64url");
  assert.throws(() => verifyAccessToken(challengeToken, { environment }));
});

test("access JWT rejects malformed, wrongly signed and mismatched issuer/audience tokens safely", () => {
  const other = validateEnv({
    NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    JWT_ACCESS_SECRET: "different-access-secret-with-over-32-characters",
    JWT_REFRESH_SECRET: "different-refresh-secret-with-over-32-characters",
    JWT_ISSUER: "other-issuer", JWT_AUDIENCE: "other-audience",
  });
  const wrongClaims = jwt.sign({ sub: "user-1" }, environment.jwt.accessSecret, {
    algorithm: "HS256", issuer: "other-issuer", audience: "other-audience", expiresIn: "1m",
  });
  const expired = jwt.sign({ sub: "user-1" }, environment.jwt.accessSecret, {
    algorithm: "HS256", issuer: environment.jwt.issuer, audience: environment.jwt.audience, expiresIn: -1,
  });
  for (const token of ["not-a-jwt", signAccessToken("user-1", { environment: other }), wrongClaims, expired]) {
    assert.throws(() => verifyAccessToken(token, { environment }), (error) => {
      assert.equal(error.message, "Access token is invalid");
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});
