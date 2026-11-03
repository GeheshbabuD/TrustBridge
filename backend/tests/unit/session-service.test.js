import assert from "node:assert/strict";
import test from "node:test";
import { validateEnv } from "../../src/config/env.js";
import { createSessionService } from "../../src/services/session.service.js";
import { hashRefreshToken } from "../../src/utils/refresh-token.js";
import { verifyAccessToken } from "../../src/utils/jwt.js";

const environment = validateEnv({
  NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost:5432/trustbridge_test",
  JWT_ACCESS_SECRET: "synthetic-access-secret-with-over-32-characters",
  JWT_REFRESH_SECRET: "synthetic-refresh-secret-with-over-32-characters",
  JWT_REFRESH_TTL: "7d",
});

const makeStore = () => {
  const rows = [];
  const user = { id: "user-1", status: "ACTIVE", role: "USER", authVersion: 0, mfa: null };
  let lock = Promise.resolve();
  const model = (txRows) => ({
    findUnique: async ({ where }) => {
      const row = where.tokenHash ? txRows.find((r) => r.tokenHash === where.tokenHash) : txRows.find((r) => r.id === where.id);
      if (!row) return null;
      return { ...row, user: { ...user }, rotatedTo: txRows.find((candidate) => candidate.rotatedFromId === row.id) ?? null };
    },
    create: async ({ data }) => {
      const row = { id: `id-${txRows.length + 1}`, ...data, revokedAt: null, rotatedFromId: data.rotatedFromId ?? null, reuseDetectedAt: null };
      txRows.push(row);
      return row;
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of txRows) {
        const matches = Object.entries(where).every(([key, value]) => {
          if (value === null) return row[key] === null;
          if (value && typeof value === "object" && "gt" in value) return row[key] > value.gt;
          return row[key] === value;
        });
        if (matches) { Object.assign(row, data); count += 1; }
      }
      return { count };
    },
  });
  return {
    rows,
    user,
    client: {
      user: { findUnique: async () => ({ ...user }) },
      refreshToken: model(rows),
      $transaction: async (callback) => {
        let release;
        const previous = lock;
        lock = new Promise((resolve) => { release = resolve; });
        await previous;
        try { return await callback({ refreshToken: model(rows) }); } finally { release(); }
      },
    },
  };
};

const serviceFor = (store, clock = () => new Date("2026-01-01T00:00:00.000Z")) => {
  let seq = 0;
  return createSessionService({
    getClient: async () => store.client,
    environment,
    makeToken: () => Buffer.alloc(32, ++seq).toString("base64url"),
    signAccess: (userId) => `jwt:${userId}`,
    makeId: () => `family-${seq}`,
    now: clock,
  });
};

test("login session stores only a SHA-256 token hash and rotation preserves family lineage", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  const issued = await sessions.issueForUser("user-1");
  const stored = store.rows[0];
  assert.equal(stored.tokenHash, hashRefreshToken(issued.refreshToken));
  assert.equal(JSON.stringify(stored).includes(issued.refreshToken), false);
  const rotated = await sessions.refresh(issued.refreshToken);
  const replacement = store.rows[1];
  assert.equal(stored.revocationReason, "rotated");
  assert.equal(replacement.familyId, stored.familyId);
  assert.equal(replacement.rotatedFromId, stored.id);
  assert.equal(rotated.accessToken, "jwt:user-1");
});

test("refresh token reuse revokes its whole family and unknown tokens fail generically", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  const issued = await sessions.issueForUser("user-1");
  await sessions.refresh(issued.refreshToken);
  await assert.rejects(sessions.refresh(issued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });
  assert.ok(store.rows.every((row) => row.revokedAt instanceof Date));
  await assert.rejects(sessions.refresh("x".repeat(43)), { code: "INVALID_REFRESH_TOKEN" });
});

test("expired refresh tokens cannot be rotated", async () => {
  const store = makeStore();
  const issued = await serviceFor(store).issueForUser("user-1");
  const afterExpiry = serviceFor(store, () => new Date("2026-01-09T00:00:00.000Z"));
  await assert.rejects(afterExpiry.refresh(issued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });
  assert.equal(store.rows[0].revokedAt, null);
});

test("logout is idempotent for known, repeated and unknown token values", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  const issued = await sessions.issueForUser("user-1");
  await sessions.logout(issued.refreshToken);
  await sessions.logout(issued.refreshToken);
  await sessions.logout("x".repeat(43));
  assert.equal(store.rows[0].revocationReason, "logout");
});

test("concurrent refresh attempts allow one rotation and treat the loser as replay", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  const issued = await sessions.issueForUser("user-1");
  const outcomes = await Promise.allSettled([
    sessions.refresh(issued.refreshToken),
    sessions.refresh(issued.refreshToken),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.ok(store.rows.every((row) => row.revokedAt instanceof Date));
});

test("ADMIN and active-MFA accounts cannot receive password-only sessions; verified assurance persists", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  store.user.role = "ADMIN";
  store.user.mfa = { enrollmentStatus: "ENABLED", enabledAt: new Date("2026-01-01T00:00:00Z") };
  await assert.rejects(sessions.issueForUser("user-1"), { code: "INVALID_CREDENTIALS" });
  const verifiedAt = new Date("2026-01-01T00:00:00Z");
  const issued = await sessions.issueForUser("user-1", { mfaVerifiedAt: verifiedAt, expectedAuthVersion: 0 });
  assert.equal(store.rows[0].mfaVerifiedAt, verifiedAt);
  assert.equal(store.rows[0].authVersion, 0);
  const refreshed = await sessions.refresh(issued.refreshToken);
  assert.equal(store.rows[1].mfaVerifiedAt, verifiedAt);
  assert.equal(store.rows[1].authVersion, 0);
  assert.equal(refreshed.refreshToken.length, 43);
});

test("issued access JWT assurance is backend signed, tied to the persisted refresh session and preserved on rotation", async () => {
  const store = makeStore();
  store.user.role = "ADMIN";
  store.user.mfa = { enrollmentStatus: "ENABLED", enabledAt: new Date("2026-01-01T00:00:00Z") };
  let sequence = 0;
  const sessions = createSessionService({
    getClient: async () => store.client,
    environment,
    makeToken: () => Buffer.alloc(32, ++sequence).toString("base64url"),
    hashToken: hashRefreshToken,
    makeId: () => `family-${sequence}`,
    now: () => new Date("2026-01-01T00:01:00Z"),
  });
  const verifiedAt = new Date("2026-01-01T00:00:30Z");
  const issued = await sessions.issueForUser("user-1", { mfaVerifiedAt: verifiedAt });
  const claims = verifyAccessToken(issued.accessToken, { environment, now: () => new Date("2026-01-01T00:01:00Z") });
  assert.equal(claims.userId, "user-1");
  assert.equal(claims.authVersion, 0);
  assert.equal(claims.sessionId, store.rows[0].id);
  assert.equal(claims.mfaVerifiedAt.getTime(), verifiedAt.getTime());

  const refreshed = await sessions.refresh(issued.refreshToken);
  const refreshedClaims = verifyAccessToken(refreshed.accessToken, { environment, now: () => new Date("2026-01-01T00:01:00Z") });
  assert.equal(refreshedClaims.sessionId, store.rows[1].id);
  assert.equal(refreshedClaims.mfaVerifiedAt.getTime(), verifiedAt.getTime());
});

test("refresh rechecks account status, role policy and auth version and cannot upgrade assurance", async () => {
  const store = makeStore();
  const sessions = serviceFor(store);
  const issued = await sessions.issueForUser("user-1");
  store.user.mfa = { enrollmentStatus: "ENABLED", enabledAt: new Date("2026-01-01T00:00:00Z") };
  await assert.rejects(sessions.refresh(issued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });

  const versionStore = makeStore();
  const versionIssued = await serviceFor(versionStore).issueForUser("user-1");
  versionStore.user.authVersion += 1;
  await assert.rejects(serviceFor(versionStore).refresh(versionIssued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });

  const inactiveStore = makeStore();
  const inactiveIssued = await serviceFor(inactiveStore).issueForUser("user-1");
  inactiveStore.user.status = "DEACTIVATED";
  await assert.rejects(serviceFor(inactiveStore).refresh(inactiveIssued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });
});
