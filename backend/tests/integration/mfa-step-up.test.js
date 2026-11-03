import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET ??= "step-up-integration-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "step-up-integration-refresh-secret-0123456789";

const [{ createApp }, { validateEnv }, { createAuthenticationMiddleware }, { createMfaStepUpRateLimiter }] = await Promise.all([
  import("../../src/app.js"),
  import("../../src/config/env.js"),
  import("../../src/middleware/auth.middleware.js"),
  import("../../src/middleware/rateLimit.middleware.js"),
]);

const environment = validateEnv({ NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL, JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET });
const authContext = Object.freeze({ userId: "11111111-1111-4111-8111-111111111111", role: "USER", authVersion: 1, sessionId: "22222222-2222-4222-8222-222222222222", mfaEnabled: true, mfaVerifiedAt: new Date("2026-01-01T00:00:00Z") });
const opaqueToken = "A".repeat(43);
const authenticate = (_request, _response, next) => { _request.auth = authContext; next(); };
const withServer = async (app, callback) => {
  const server = app.listen(0);
  await once(server, "listening");
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { const closed = once(server, "close"); server.close(); await closed; }
};

test("authenticated step-up challenge and verification endpoints return bound proof without creating tokens", async () => {
  const observed = [];
  const app = createApp(environment, {
    writeLog: () => {},
    authenticationMiddleware: authenticate,
    stepUpPurposes: { TEST_ACTION: { resourceType: "TRANSACTION", resourceRequired: true, allowedRoles: ["USER"], maxAgeSeconds: 180, additionalAuthorizationRequired: true, oneTime: true } },
    mfaService: {
      createStepUpChallenge: async (input) => { observed.push(input); return { challengeToken: opaqueToken, purpose: "TEST_ACTION", resourceType: "TRANSACTION", resourceId: "33333333-3333-4333-8333-333333333333", expiresAt: "2026-01-01T00:05:00.000Z" }; },
      verifyStepUpChallenge: async (input) => { observed.push(input); return { purpose: "TEST_ACTION", resourceType: "TRANSACTION", resourceId: "33333333-3333-4333-8333-333333333333", verifiedAt: "2026-01-01T00:00:00.000Z" }; },
    },
  });
  await withServer(app, async (base) => {
    const create = await fetch(`${base}/api/v1/auth/mfa/step-up/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "TEST_ACTION", resourceId: "33333333-3333-4333-8333-333333333333" }) });
    assert.equal(create.status, 201);
    const createBody = await create.json();
    assert.equal(createBody.data.challengeToken, opaqueToken);
    assert.doesNotMatch(JSON.stringify(createBody), /hash|ciphertext|secretKey|accessToken|refreshToken/i);

    const verify = await fetch(`${base}/api/v1/auth/mfa/step-up/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: opaqueToken, code: "123456", userId: "forged" }) });
    assert.equal(verify.status, 400);
    const success = await fetch(`${base}/api/v1/auth/mfa/step-up/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: opaqueToken, code: "123456" }) });
    assert.equal(success.status, 200);
    const successBody = await success.json();
    assert.equal(successBody.data.purpose, "TEST_ACTION");
    assert.equal(Object.hasOwn(successBody.data, "accessToken"), false);
    assert.equal(Object.hasOwn(successBody.data, "refreshToken"), false);
    assert.equal(observed[0].auth, authContext);
    assert.equal(observed[1].auth, authContext);
  });
});

test("step-up endpoints require authentication and return safe validation errors", async () => {
  const deniedAuth = createAuthenticationMiddleware({ verify: () => { throw new Error("private verifier detail"); } });
  const app = createApp(environment, { writeLog: () => {}, authenticationMiddleware: deniedAuth, mfaService: {} });
  await withServer(app, async (base) => {
    const unauthenticated = await fetch(`${base}/api/v1/auth/mfa/step-up/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "TEST_ACTION", resourceId: "33333333-3333-4333-8333-333333333333" }) });
    assert.equal(unauthenticated.status, 401);
    const malformed = await fetch(`${base}/api/v1/auth/mfa/step-up/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: "opaque", code: "123456", userId: "forged" }) });
    assert.equal(malformed.status, 401);
    assert.doesNotMatch(await malformed.text(), /private verifier detail|forged|secret/i);
  });
});

test("step-up challenge creation and verification have independent limits", async () => {
  const limiter = () => createMfaStepUpRateLimiter({ windowMs: 60_000, max: 1 });
  const app = createApp(environment, { writeLog: () => {}, authenticationMiddleware: authenticate, mfaService: { createStepUpChallenge: async () => ({ challengeToken: "opaque", purpose: "X" }), verifyStepUpChallenge: async () => ({ purpose: "X" }) }, mfaStepUpCreateRateLimiter: limiter(), mfaStepUpVerifyRateLimiter: limiter() });
  await withServer(app, async (base) => {
    const send = () => fetch(`${base}/api/v1/auth/mfa/step-up/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "TEST_ACTION", resourceId: "33333333-3333-4333-8333-333333333333" }) });
    assert.equal((await send()).status, 201);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "MFA_STEP_UP_RATE_LIMITED");
  });
});
