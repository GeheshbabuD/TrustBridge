import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "mfa-test-access-secret-with-more-than-32-characters";
process.env.JWT_REFRESH_SECRET = "mfa-test-refresh-secret-with-more-than-32-characters";

const [{ createApp }, { validateEnv }, { createMfaVerificationRateLimiter }, { createAuthenticationMiddleware }, { MfaServiceError }] = await Promise.all([
  import("../../src/app.js"),
  import("../../src/config/env.js"),
  import("../../src/middleware/rateLimit.middleware.js"),
  import("../../src/middleware/auth.middleware.js"),
  import("../../src/services/mfa.service.js"),
]);

const environment = validateEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
});

const withServer = async (app, callback) => {
  const server = app.listen(0);
  await once(server, "listening");
  try { const address = server.address(); await callback(`http://127.0.0.1:${address.port}`); }
  finally { const closed = once(server, "close"); server.close(); await closed; }
};

const authenticated = (_request, _response, next) => { _request.auth = Object.freeze({ userId: "user-1", role: "USER" }); next(); };
const makeApp = (mfaService, extra = {}) => createApp(environment, { writeLog: extra.writeLog ?? (() => {}), mfaService, authenticationMiddleware: extra.authenticationMiddleware ?? authenticated, mfaVerificationRateLimiter: extra.limiter });

test("authenticated enrollment returns provisioning data while logs exclude secrets and URI", async () => {
  const secret = "DO-NOT-LOG-TOTP-SEED";
  const uri = `otpauth://totp/TrustBridge:user%40example.test?secret=${secret}`;
  const logs = [];
  const app = makeApp({
    startEnrollment: async ({ userId }) => { assert.equal(userId, "user-1"); return { enrollmentId: "enroll-1", expiresAt: "2026-01-01T00:10:00.000Z", secret, provisioningUri: uri }; },
    verifyEnrollment: async () => ({ enabled: true, recoveryCodes: ["once-only-code"] }),
    getStatus: async () => ({ enabled: false, enrollmentPending: true, requiredByPolicy: false, unusedRecoveryCodes: 0 }),
  }, { writeLog: (record) => logs.push(record) });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/mfa/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.data.secret, secret);
    assert.equal(payload.data.provisioningUri, uri);
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.equal(JSON.stringify(logs).includes(uri), false);
  });
});

test("verification returns one-time recovery codes only on activation and status is sanitized", async () => {
  const logs = [];
  const app = makeApp({
    startEnrollment: async () => assert.fail("not used"),
    verifyEnrollment: async ({ code }) => { if (code !== "654321") throw new MfaServiceError(400, "MFA_VERIFICATION_FAILED"); return { enabled: true, recoveryCodes: ["one-time-recovery-code"] }; },
    getStatus: async () => ({ enabled: true, enrollmentPending: false, requiredByPolicy: true, unusedRecoveryCodes: 9 }),
  }, { writeLog: (record) => logs.push(record) });
  await withServer(app, async (baseUrl) => {
    const failed = await fetch(`${baseUrl}/api/v1/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
    const failedPayload = await failed.json();
    assert.equal(failed.status, 400);
    assert.equal(JSON.stringify(failedPayload).includes("one-time-recovery-code"), false);

    const success = await fetch(`${baseUrl}/api/v1/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "654321" }) });
    const successPayload = await success.json();
    assert.equal(success.status, 200);
    assert.deepEqual(successPayload.data.recoveryCodes, ["one-time-recovery-code"]);
    assert.equal(JSON.stringify(logs).includes("654321"), false);
    assert.equal(JSON.stringify(logs).includes("one-time-recovery-code"), false);

    const status = await fetch(`${baseUrl}/api/v1/auth/mfa/status`);
    const statusPayload = await status.json();
    assert.equal(status.status, 200);
    assert.deepEqual(statusPayload.data, { enabled: true, enrollmentPending: false, requiredByPolicy: true, unusedRecoveryCodes: 9 });
    assert.doesNotMatch(JSON.stringify(statusPayload), /one-time-recovery-code|ciphertext|keyId|secretHash|challenge/i);
  });
});

test("enrollment verification rate limit counts failures per authenticated user and skips success", async () => {
  let calls = 0;
  const app = makeApp({
    startEnrollment: async () => null,
    verifyEnrollment: async () => { calls += 1; throw new MfaServiceError(400, "MFA_VERIFICATION_FAILED"); },
    getStatus: async () => null,
  }, { limiter: createMfaVerificationRateLimiter({ windowMs: 60000, max: 2 }) });
  await withServer(app, async (baseUrl) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/v1/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
      assert.equal(response.status, 400);
    }
    const limited = await fetch(`${baseUrl}/api/v1/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
    const payload = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(payload.error.code, "MFA_VERIFICATION_RATE_LIMITED");
    assert.equal(calls, 2);
  });
});

test("inactive accounts cannot access MFA endpoints even with a valid token", async () => {
  let calls = 0;
  const auth = createAuthenticationMiddleware({ verify: () => ({ userId: "user-1" }), getClient: async () => ({ user: { findUnique: async () => ({ id: "user-1", status: "DEACTIVATED" }) } }) });
  const app = makeApp({ startEnrollment: async () => { calls += 1; }, verifyEnrollment: async () => null, getStatus: async () => null }, { authenticationMiddleware: auth });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/mfa/enroll`, { method: "POST", headers: { authorization: "Bearer valid-token", "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });
});

test("unauthenticated enrollment is rejected before MFA service access", async () => {
  let calls = 0;
  const auth = createAuthenticationMiddleware({ verify: () => { throw new Error("invalid token"); } });
  const app = makeApp({ startEnrollment: async () => { calls += 1; }, verifyEnrollment: async () => null, getStatus: async () => null }, { authenticationMiddleware: auth });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/mfa/status`);
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });
});
