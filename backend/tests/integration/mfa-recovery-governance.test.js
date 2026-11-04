import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "recovery-test-access-secret-with-more-than-32-characters";
process.env.JWT_REFRESH_SECRET = "recovery-test-refresh-secret-with-more-than-32-characters";

const [{ createApp }, { validateEnv }, { ApiError }] = await Promise.all([
  import("../../src/app.js"),
  import("../../src/config/env.js"),
  import("../../src/utils/ApiError.js"),
]);

const environment = validateEnv({ NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL, JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET });
const auth = Object.freeze({ userId: "11111111-1111-4111-8111-111111111111", role: "USER", authVersion: 3, sessionId: "22222222-2222-4222-8222-222222222222", assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date("2026-01-01T00:00:00Z") });

const withServer = async (app, callback) => {
  const server = app.listen(0);
  await once(server, "listening");
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { const closed = once(server, "close"); server.close(); await closed; }
};

test("recovery-code regeneration is authenticated, uses the one-time self-resource purpose and returns codes once", async () => {
  const logs = [];
  const requests = [];
  let grantAvailable = true;
  const app = createApp(environment, {
    writeLog: (record) => logs.push(record),
    authenticationMiddleware: (request, _response, next) => { request.auth = auth; request.requestId = "request-safe-id"; next(); },
    stepUpAuthorizationMiddlewareFactory: (options) => {
      if (options.purpose !== "MFA_RECOVERY_CODES_REGENERATE") return (_request, _response, next) => next();
      assert.equal(options.purpose, "MFA_RECOVERY_CODES_REGENERATE");
      assert.equal(options.purposeRegistry.MFA_RECOVERY_CODES_REGENERATE.oneTime, true);
      return (request, _response, next) => {
        assert.equal(options.resourceId(request), auth.userId);
        if (!grantAvailable) return next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required"));
        grantAvailable = false;
        next();
      };
    },
    mfaService: { regenerateRecoveryCodes: async (input) => { requests.push(input); return { batchId: "opaque-batch-id", codes: Array.from({ length: 10 }, (_, index) => `private-code-${index}`) }; } },
  });
  await withServer(app, async (base) => {
    const send = () => fetch(`${base}/api/v1/auth/mfa/recovery-codes/regenerate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const first = await send();
    const firstPayload = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstPayload.data.codes.length, 10);
    assert.equal(Object.hasOwn(firstPayload.data, "batchId"), false);
    assert.equal((await send()).status, 403);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, auth);
    assert.equal(requests[0].requestId, "request-safe-id");
    assert.doesNotMatch(JSON.stringify(logs), /private-code|codeHash|secretCiphertext/);
  });
});

