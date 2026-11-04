import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "auth-test-access-secret-with-more-than-32-characters";
process.env.JWT_REFRESH_SECRET = "auth-test-refresh-secret-with-more-than-32-characters";

const [{ createApp }, { validateEnv }, { AuthServiceError }] = await Promise.all([
  import("../../src/app.js"),
  import("../../src/config/env.js"),
  import("../../src/services/auth.service.js"),
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
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

const makeApp = (authService, sessionService, extra = {}) => createApp(environment, { writeLog: () => {}, authService, sessionService, ...extra });

test("registration endpoint normalizes and validates input, then returns only safe user data", async () => {
  let received;
  const app = makeApp({
    register: async (body) => {
      received = body;
      return {
        id: "user-1",
        email: body.email,
        createdAt: "2026-01-01T00:00:00.000Z",
        profile: { displayName: body.displayName ?? null },
      };
    },
    login: async () => assert.fail("login should not be called"),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "  BUYER@EXAMPLE.TEST ",
        password: "correct horse battery staple!",
        displayName: " Buyer Example ",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(received.email, "buyer@example.test");
    assert.equal(received.password, "correct horse battery staple!");
    assert.equal(received.displayName, "Buyer Example");
    assert.deepEqual(payload.data.user.profile, { displayName: "Buyer Example" });
    assert.equal(JSON.stringify(payload).includes("passwordHash"), false);
    assert.equal(JSON.stringify(payload).includes("password"), false);
    assert.equal(JSON.stringify(payload).includes("token"), false);
  });
});

test("registration rejects role/status injection and does not echo invalid passwords", async () => {
  let calls = 0;
  const app = makeApp({
    register: async () => { calls += 1; },
    login: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const injected = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.test", password: "valid enough password!", role: "ADMIN", status: "ACTIVE" }),
    });
    assert.equal(injected.status, 400);
    assert.equal(calls, 0);

    const marker = "private-invalid-password-DoNotEcho";
    const invalid = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.test", password: marker.repeat(3) }),
    });
    const payload = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(payload).includes(marker), false);
    assert.equal(calls, 0);
  });
});

test("duplicate registration returns a safe conflict response", async () => {
  const marker = "database-index-name-never-return";
  const app = makeApp({
    register: async () => { throw new AuthServiceError(409, "REGISTRATION_CONFLICT", marker); },
    login: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.test", password: "correct horse battery staple!" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "REGISTRATION_CONFLICT");
    assert.equal(JSON.stringify(payload).includes(marker), false);
  });
});

test("login normalizes email and returns the safe user with issued tokens", async () => {
  let received;
  const app = makeApp({
    register: async () => null,
    login: async (body) => {
      received = body;
      return {
        user: { id: "user-1", email: body.email, createdAt: "2026-01-01T00:00:00.000Z", profile: { displayName: null } },
        accessToken: "synthetic-access-jwt", refreshToken: "synthetic-opaque-refresh-token", tokenType: "Bearer",
      };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: " BUYER@EXAMPLE.TEST ", password: "legacy" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(received.email, "buyer@example.test");
    assert.equal(received.password, "legacy");
    assert.equal(JSON.stringify(payload).includes("passwordHash"), false);
    assert.equal(payload.data.accessToken, "synthetic-access-jwt");
    assert.equal(payload.data.refreshToken, "synthetic-opaque-refresh-token");
    assert.equal(JSON.stringify(payload).includes("passwordHash"), false);
    assert.equal(response.headers.get("authorization"), null);
  });
});

test("MFA login returns a limited challenge without tokens, then challenge verification issues tokens", async () => {
  let verification;
  const challengeToken = Buffer.alloc(32, 8).toString("base64url");
  const app = makeApp({
    register: async () => null,
    login: async () => ({ mfaRequired: true, challengeToken, expiresAt: "2026-01-01T00:05:00.000Z" }),
    verifyLoginChallenge: async (input) => { verification = input; return { accessToken: "mfa-access", refreshToken: "mfa-refresh", tokenType: "Bearer" }; },
  });
  await withServer(app, async (baseUrl) => {
    const pendingResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.test", password: "correct password" }),
    });
    const pending = await pendingResponse.json();
    assert.equal(pendingResponse.status, 202);
    assert.deepEqual(pending.data, { mfaRequired: true, challengeToken, expiresAt: "2026-01-01T00:05:00.000Z" });
    assert.equal(JSON.stringify(pending).includes("accessToken"), false);
    assert.equal(JSON.stringify(pending).includes("refreshToken"), false);

    const invalidExtra = await fetch(`${baseUrl}/api/v1/auth/mfa/challenge/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code: "123456", userId: "attacker-account" }),
    });
    assert.equal(invalidExtra.status, 400);
    assert.equal(verification, undefined);

    const verifiedResponse = await fetch(`${baseUrl}/api/v1/auth/mfa/challenge/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code: "123456" }),
    });
    const verified = await verifiedResponse.json();
    assert.equal(verifiedResponse.status, 200);
    assert.deepEqual(verification, { challengeToken, code: "123456" });
    assert.deepEqual(verified.data, { accessToken: "mfa-access", refreshToken: "mfa-refresh", tokenType: "Bearer" });
    assert.equal(JSON.stringify(verified).includes(challengeToken), false);

    const recoveryResponse = await fetch(`${baseUrl}/api/v1/auth/mfa/challenge/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code: "a".repeat(32) }),
    });
    assert.equal(recoveryResponse.status, 200);
    assert.deepEqual(verification, { challengeToken, code: "a".repeat(32) });
  });
});

test("login and login-MFA verification have dedicated rate limits", async () => {
  let loginCalls = 0;
  let verifyCalls = 0;
  const app = makeApp({
    register: async () => null,
    login: async () => { loginCalls += 1; return { user: {}, accessToken: "a", refreshToken: "r", tokenType: "Bearer" }; },
    verifyLoginChallenge: async () => { verifyCalls += 1; return {}; },
  }, undefined, {
    authLoginRateLimiter: (await import("../../src/middleware/rateLimit.middleware.js")).createAuthLoginRateLimiter({ windowMs: 60000, max: 1 }),
    mfaChallengeRateLimiter: (await import("../../src/middleware/rateLimit.middleware.js")).createMfaChallengeRateLimiter({ windowMs: 60000, max: 1 }),
  });
  await withServer(app, async (baseUrl) => {
    const loginRequest = () => fetch(`${baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.test", password: "correct password" }) });
    assert.equal((await loginRequest()).status, 200);
    const throttledLogin = await loginRequest();
    assert.equal(throttledLogin.status, 429);
    assert.equal((await throttledLogin.json()).error.code, "AUTH_LOGIN_RATE_LIMITED");

    const challengeRequest = () => fetch(`${baseUrl}/api/v1/auth/mfa/challenge/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: Buffer.alloc(32, 9).toString("base64url"), code: "123456" }) });
    assert.equal((await challengeRequest()).status, 200);
    const throttledChallenge = await challengeRequest();
    assert.equal(throttledChallenge.status, 429);
    assert.equal((await throttledChallenge.json()).error.code, "MFA_CHALLENGE_RATE_LIMITED");
  });
  assert.equal(loginCalls, 1);
  assert.equal(verifyCalls, 1);
});

test("refresh rotates a valid refresh token and logout is idempotent", async () => {
  const received = [];
  const app = makeApp({ register: async () => null, login: async () => null }, {
    refresh: async (token) => { received.push(["refresh", token]); return { accessToken: "new-jwt", refreshToken: "new-refresh-token", tokenType: "Bearer" }; },
    logout: async (token) => { received.push(["logout", token]); },
  });
  await withServer(app, async (baseUrl) => {
    const refreshToken = Buffer.alloc(32, 4).toString("base64url");
    const refreshed = await fetch(`${baseUrl}/api/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).data.refreshToken, "new-refresh-token");
    for (let i = 0; i < 2; i += 1) {
      const loggedOut = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) });
      assert.equal(loggedOut.status, 200);
    }
    assert.deepEqual(received, [["refresh", refreshToken], ["logout", refreshToken], ["logout", refreshToken]]);
  });
});

test("unknown, incorrect and inactive credentials share the same generic login error", async () => {
  const app = makeApp({
    register: async () => null,
    login: async ({ email }) => {
      throw new AuthServiceError(401, "INVALID_CREDENTIALS", `private detail ${email}`);
    },
  });
  const payloads = [];

  await withServer(app, async (baseUrl) => {
    for (const email of ["unknown@example.test", "incorrect@example.test", "inactive@example.test"]) {
      const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password" }),
      });
      payloads.push({ status: response.status, body: await response.json() });
    }
  });

  assert.equal(payloads[0].status, 401);
  for (const result of payloads.slice(1)) {
    assert.equal(result.status, payloads[0].status);
    for (const key of ["success", "message", "data", "error"]) {
      assert.deepEqual(result.body[key], payloads[0].body[key]);
    }
  }
  assert.equal(payloads[0].body.error.code, "INVALID_CREDENTIALS");
  assert.equal(payloads[0].body.message, "Email or password is incorrect");
});

test("unexpected database failures remain generic server errors", async () => {
  const marker = "private-connection-string-marker";
  const app = makeApp({
    register: async () => { throw new Error(marker); },
    login: async () => { throw new Error(marker); },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.test", password: "password" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.error.code, "INTERNAL_SERVER_ERROR");
    assert.equal(JSON.stringify(payload).includes(marker), false);
  });
});
