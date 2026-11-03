import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticationMiddleware } from "../../src/middleware/auth.middleware.js";

const invoke = async (middleware, authorization) => {
  const request = { get: (name) => name === "authorization" ? authorization : undefined };
  let nextValue;
  await middleware(request, {}, (value) => { nextValue = value; });
  return { request, nextValue };
};

test("Bearer middleware rejects missing/invalid JWTs and never queries user for them", async () => {
  let lookups = 0;
  const middleware = createAuthenticationMiddleware({
    getClient: async () => { lookups += 1; return {}; },
    verify: (token) => { if (token !== "valid") throw new Error("private token detail"); return { userId: "u1", role: "ADMIN", authVersion: 0 }; },
  });
  for (const header of [undefined, "Basic valid", "Bearer invalid"]) {
    const { nextValue } = await invoke(middleware, header);
    assert.equal(nextValue.statusCode, 401);
    assert.equal(nextValue.code, "AUTHENTICATION_REQUIRED");
  }
  assert.equal(lookups, 0);
});

test("Bearer middleware trusts current database status and role, not token-supplied role", async () => {
  let query;
  const middleware = createAuthenticationMiddleware({
    getClient: async () => ({ user: { findUnique: async (args) => { query = args; return { id: "u1", role: "USER", status: "ACTIVE", authVersion: 0, mfa: null }; } } }),
    verify: () => ({ userId: "u1", role: "ADMIN", authVersion: 0 }),
  });
  const { request, nextValue } = await invoke(middleware, "Bearer valid");
  assert.equal(nextValue, undefined);
  assert.deepEqual(query.where, { id: "u1" });
  assert.deepEqual(request.auth, { userId: "u1", role: "USER", authVersion: 0, mfaEnabled: false, mfaVerifiedAt: null, sessionId: null });
});

test("inactive or missing users are denied", async () => {
  for (const user of [null, { id: "u1", role: "USER", status: "SUSPENDED", authVersion: 0, mfa: null }]) {
    const middleware = createAuthenticationMiddleware({
      getClient: async () => ({ user: { findUnique: async () => user } }),
      verify: () => ({ userId: "u1", authVersion: 0 }),
    });
    const { nextValue } = await invoke(middleware, "Bearer valid");
    assert.equal(nextValue.statusCode, 401);
  }
});

test("repeated authentication middleware in one request reuses the verified context", async () => {
  let queries = 0;
  const middleware = createAuthenticationMiddleware({
    getClient: async () => ({ user: { findUnique: async () => { queries += 1; return { id: "u1", role: "USER", status: "ACTIVE", authVersion: 0, mfa: null }; } } }),
    verify: () => ({ userId: "u1", authVersion: 0 }),
  });
  const request = { get: () => "Bearer valid", body: { userId: "attacker", role: "ADMIN" } };
  await middleware(request, {}, () => {});
  await middleware(request, {}, () => {});
  assert.equal(queries, 1);
  assert.deepEqual(request.auth, { userId: "u1", role: "USER", authVersion: 0, mfaEnabled: false, mfaVerifiedAt: null, sessionId: null });
});

test("active-MFA accounts require session-bound MFA claims and current auth version", async () => {
  const verifiedAt = new Date("2026-01-01T00:00:00Z");
  const account = { id: "u1", role: "USER", status: "ACTIVE", authVersion: 3, mfa: { enrollmentStatus: "ENABLED", enabledAt: verifiedAt } };
  const make = (claims, session = { userId: "u1", authVersion: 3, mfaVerifiedAt: verifiedAt }, currentUser = account) => createAuthenticationMiddleware({
    getClient: async () => ({ user: { findUnique: async () => currentUser }, refreshToken: { findUnique: async () => session } }),
    verify: () => claims,
    now: () => verifiedAt,
  });
  const valid = await invoke(make({ userId: "u1", authVersion: 3, sessionId: "s1", mfaVerifiedAt: verifiedAt }, { userId: "u1", authVersion: 3, mfaVerifiedAt: verifiedAt, expiresAt: new Date("2026-01-02T00:00:00Z") }), "Bearer valid");
  assert.equal(valid.nextValue, undefined);
  assert.equal(valid.request.auth.mfaEnabled, true);
  assert.equal(valid.request.auth.mfaVerifiedAt.getTime(), verifiedAt.getTime());

  for (const middleware of [
    make({ userId: "u1", authVersion: 3, sessionId: "s1", mfaVerifiedAt: null }, { userId: "u1", authVersion: 3, mfaVerifiedAt: null, expiresAt: new Date("2026-01-02T00:00:00Z") }),
    make({ userId: "u1", authVersion: 2, sessionId: "s1", mfaVerifiedAt: verifiedAt }, { userId: "u1", authVersion: 3, mfaVerifiedAt: verifiedAt, expiresAt: new Date("2026-01-02T00:00:00Z") }),
    make({ userId: "u1", authVersion: 3, sessionId: "s1", mfaVerifiedAt: verifiedAt }, { userId: "u1", authVersion: 3, mfaVerifiedAt: null, expiresAt: new Date("2026-01-02T00:00:00Z") }),
    make({ userId: "u1", authVersion: 3, sessionId: "s1", mfaVerifiedAt: verifiedAt }, { userId: "u1", authVersion: 3, mfaVerifiedAt: verifiedAt, revokedAt: new Date(), expiresAt: new Date("2026-01-02T00:00:00Z") }),
  ]) {
    const result = await invoke(middleware, "Bearer valid");
    assert.equal(result.nextValue.statusCode, 401);
  }
});
