import assert from "node:assert/strict";
import test from "node:test";
import { createUserService, UserServiceError } from "../../src/services/user.service.js";

const auth = { userId: "11111111-1111-4111-8111-111111111111", role: "USER", authVersion: 4, sessionId: "22222222-2222-4222-8222-222222222222", mfaEnabled: false };

test("profile update locks and checks the current account, merges preferences, and returns only safe user fields", async () => {
  const order = [];
  let profileUpdate;
  const profile = { preferences: { locale: "en" }, notificationPreferences: { transactionUpdates: true } };
  const user = { id: auth.userId, email: "person@example.test", role: "USER", status: "ACTIVE", createdAt: new Date(), profile: { displayName: "Ada", ...profile } };
  const tx = {
    $queryRaw: async () => { order.push("user.lock"); return []; },
    user: { findUnique: async ({ select }) => select.profile ? user : ({ id: auth.userId, status: "ACTIVE", authVersion: 4 }) },
    profile: {
      findUnique: async ({ select }) => select.preferences ? { preferences: profile.preferences } : { notificationPreferences: profile.notificationPreferences },
      upsert: async ({ update }) => { order.push("profile.upsert"); profileUpdate = update; Object.assign(profile, update); },
    },
  };
  const service = createUserService({ getClient: async () => ({ $transaction: (fn) => fn(tx), user: { findUnique: async () => user } }) });
  const result = await service.updateMe({ auth, input: { displayName: "Ada Lovelace", preferences: { locale: "fr" }, notificationPreferences: { productUpdates: false } } });
  assert.deepEqual(order, ["user.lock", "profile.upsert"]);
  assert.deepEqual(profileUpdate.preferences, { locale: "fr" });
  assert.deepEqual(profileUpdate.notificationPreferences, { transactionUpdates: true, productUpdates: false });
  assert.equal(result.email, "person@example.test");
  assert.equal("passwordHash" in result, false);
  assert.equal("mfa" in result, false);
});

test("password change rechecks the current password under user lock and invalidates sessions atomically", async () => {
  const events = [];
  const tx = {
    $queryRaw: async () => { events.push("lock"); return []; },
    user: {
      findUnique: async () => ({ id: auth.userId, status: "ACTIVE", authVersion: 4, passwordHash: "old-hash" }),
      update: async ({ data }) => { events.push(["user.update", data]); return { id: auth.userId }; },
    },
    refreshToken: { updateMany: async ({ data }) => { events.push(["sessions.revoke", data]); return { count: 2 }; } },
    mfaChallenge: { updateMany: async ({ data }) => { events.push(["grants.invalidate", data]); return { count: 1 }; } },
    auditLog: { create: async ({ data }) => { events.push(["audit", data]); return { id: "audit-1" }; } },
  };
  const service = createUserService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }), verify: async (password, hash) => password === "current-password" && hash === "old-hash", hash: async () => "new-hash", now: () => new Date("2026-11-04T00:00:00Z") });
  assert.deepEqual(await service.changePassword({ auth, currentPassword: "current-password", newPassword: "a brand new password" }), { changed: true, sessionsInvalidated: true });
  assert.equal(events[0], "lock");
  assert.deepEqual(events.find(([name]) => name === "user.update")[1], { passwordHash: "new-hash", authVersion: { increment: 1 } });
  assert.equal(events.find(([name]) => name === "sessions.revoke")[1].revocationReason, "password_changed");
  assert.equal(events.find(([name]) => name === "grants.invalidate")[1].grantConsumedAt instanceof Date, true);
  assert.equal(events.find(([name]) => name === "audit")[1].action, "USER_PASSWORD_CHANGED");
  await assert.rejects(service.changePassword({ auth, currentPassword: "wrong", newPassword: "another new password" }), (error) => error instanceof UserServiceError && error.code === "CURRENT_PASSWORD_INVALID");
});

test("deactivation invalidates account sessions and keeps ADMIN self-deactivation blocked", async () => {
  const changes = [];
  let currentRole = "USER";
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => ({ id: auth.userId, role: currentRole, status: "ACTIVE", authVersion: 4, mfa: null }), update: async ({ data }) => { changes.push(["user", data]); } },
    refreshToken: { updateMany: async ({ data }) => { changes.push(["session", data]); } },
    mfaChallenge: { updateMany: async ({ data }) => { changes.push(["grant", data]); } },
    auditLog: { create: async ({ data }) => { changes.push(["audit", data]); } },
  };
  const service = createUserService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }), now: () => new Date("2026-11-04T00:00:00Z") });
  assert.deepEqual(await service.deactivateMe({ auth, requestId: "req-1" }), { deactivated: true, sessionsInvalidated: true });
  assert.equal(changes.find(([kind]) => kind === "user")[1].status, "DEACTIVATED");
  assert.equal(changes.find(([kind]) => kind === "session")[1].revocationReason, "account_deactivated");
  currentRole = "ADMIN";
  await assert.rejects(service.deactivateMe({ auth: { ...auth, role: "ADMIN" } }), (error) => error.code === "FORBIDDEN");
});

test("admin status changes reject self-targeting and audit only allowlisted status metadata", async () => {
  const audits = [];
  const targetId = "33333333-3333-4333-8333-333333333333";
  const tx = {
    $queryRaw: async () => [],
    user: {
      findUnique: async ({ where }) => where.id === auth.userId
        ? { role: "ADMIN", status: "ACTIVE", authVersion: 4, mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date("2026-11-03T00:00:00Z") } }
        : { id: targetId, role: "USER", status: "ACTIVE", authVersion: 2, email: "target@example.test", createdAt: new Date(), profile: null },
      update: async () => ({}), count: async () => 1,
    },
    refreshToken: { findUnique: async () => ({ userId: auth.userId, authVersion: 4, assuranceLevel: "TOTP_VERIFIED", mfaVerifiedAt: new Date(), revokedAt: null, expiresAt: new Date("2027-01-01T00:00:00Z") }), updateMany: async () => ({ count: 1 }) },
    mfaChallenge: { updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: "audit" }; } },
  };
  const service = createUserService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }), now: () => new Date("2026-11-04T00:00:00Z") });
  const result = await service.updateUserStatus({ auth: { ...auth, role: "ADMIN" }, targetUserId: targetId, status: "SUSPENDED", reasonCode: "SECURITY_REVIEW", requestId: "req" });
  assert.equal(result.changed, true);
  assert.deepEqual(audits[0].metadata, { previousStatus: "ACTIVE", newStatus: "SUSPENDED", reasonCode: "SECURITY_REVIEW" });
  await assert.rejects(service.updateUserStatus({ auth: { ...auth, role: "ADMIN" }, targetUserId: auth.userId, status: "DEACTIVATED", reasonCode: "OTHER" }), (error) => error.code === "FORBIDDEN");
});
