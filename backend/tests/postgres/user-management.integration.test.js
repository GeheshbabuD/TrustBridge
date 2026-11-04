import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl, validateEnv } from "../../src/config/env.js";
import { createUserService, UserServiceError } from "../../src/services/user.service.js";
import { createSessionService } from "../../src/services/session.service.js";

const enabled = process.env.TRUSTBRIDGE_USER_PG_TESTS === "1";

test("TB-BE-036 PostgreSQL user management integration", { skip: !enabled }, async (t) => {
  const developmentUrl = new URL(getDatabaseUrl());
  assert.equal(developmentUrl.hostname, "localhost");
  assert.equal(developmentUrl.port || "5432", "5432");
  assert.equal(developmentUrl.pathname, "/Trustbridge");
  const testUrl = new URL(developmentUrl);
  testUrl.pathname = "/trustbridge_test";
  const testEnvironment = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: testUrl.toString(),
    JWT_ACCESS_SECRET: "postgres-test-access-secret-value-0123456789",
    JWT_REFRESH_SECRET: "postgres-test-refresh-secret-value-9876543210",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "7d",
    JWT_ISSUER: "trustbridge-user-pg-tests",
    JWT_AUDIENCE: "trustbridge-user-pg-test-client",
  });
  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([
    import("../../generated/prisma/client.ts"),
    import("@prisma/adapter-pg"),
    import("pg"),
  ]);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const secondPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const catalog = new Client({ connectionString: testUrl.toString() });
  const ownedUsers = new Set();
  const now = () => new Date();
  const service = createUserService({
    getClient: async () => prisma,
    hash: async () => "test-only-password-hash-after-change",
    verify: async (candidate, hash) => candidate === "current password" && hash === "test-only-password-hash",
    now,
  });
  const sessions = createSessionService({ getClient: async () => prisma, environment: testEnvironment, now });
  const gatedService = (client, gate) => createUserService({
    getClient: async () => ({ $transaction: async (...args) => { await gate(); return client.$transaction(...args); } }),
    hash: async () => "test-only-password-hash-after-change",
    verify: async (candidate, hash) => candidate === "current password" && hash === "test-only-password-hash",
    now,
  });
  let trigger;

  const createUser = async ({ role = "USER", mfa = false } = {}) => {
    const id = randomUUID();
    ownedUsers.add(id);
    await prisma.user.create({ data: {
      id,
      email: `${id}@user-pg-test.invalid`,
      passwordHash: "test-only-password-hash",
      role,
      status: "ACTIVE",
      authVersion: 0,
      profile: { create: { displayName: "PG test user", preferences: {}, notificationPreferences: {} } },
      ...(mfa ? { mfa: { create: {
        enrollmentStatus: "ENABLED",
        secretCiphertext: Buffer.from("test-ciphertext"),
        secretNonce: Buffer.alloc(12, 1),
        secretAuthTag: Buffer.alloc(16, 2),
        secretKeyId: "test-key",
        secretKeyVersion: 1,
        enabledAt: new Date(Date.now() - 30_000),
      } } } : {}),
    } });
    return id;
  };
  const authFor = async (userId, { mfa = false } = {}) => {
    const session = await sessions.issueForUser(userId, mfa ? { mfaVerifiedAt: new Date() } : {});
    const row = await prisma.refreshToken.findFirst({ where: { userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    return {
      session,
      auth: { userId, role: mfa ? "ADMIN" : "USER", status: "ACTIVE", authVersion: 0, sessionId: row.id, mfaEnabled: mfa, mfaVerifiedAt: mfa ? row.mfaVerifiedAt : null, assuranceLevel: mfa ? "TOTP_VERIFIED" : "PASSWORD_ONLY" },
    };
  };
  const cleanup = async () => {
    if (trigger) {
      await catalog.query(`DROP TRIGGER IF EXISTS "${trigger.name}" ON public.audit_logs`);
      await catalog.query(`DROP FUNCTION IF EXISTS public."${trigger.name}"()`);
      trigger = null;
    }
    for (const id of ownedUsers) {
      const requests = await prisma.accountRecoveryRequest.findMany({ where: { OR: [{ userId: id }, { requestedByUserId: id }] }, select: { id: true } });
      const requestIds = requests.map(({ id: requestId }) => requestId);
      if (requestIds.length) await prisma.recoveryApproval.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.recoveryApproval.deleteMany({ where: { approverId: id } });
      await prisma.accountRecoveryRequest.deleteMany({ where: { OR: [{ userId: id }, { requestedByUserId: id }] } });
      await prisma.auditLog.deleteMany({ where: { actorUserId: id } });
      await prisma.mfaChallenge.deleteMany({ where: { userId: id } });
      await prisma.mfaRecoveryCode.deleteMany({ where: { userId: id } });
      await prisma.refreshToken.deleteMany({ where: { userId: id } });
      await prisma.userMfa.deleteMany({ where: { userId: id } });
      await prisma.profile.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
  };

  try {
    await prisma.$connect();
    await secondPrisma.$connect();
    await catalog.connect();
    const identity = (await catalog.query("SELECT current_database() AS database, version() AS version, inet_server_addr()::text AS address, inet_server_port() AS port")).rows[0];
    assert.equal(identity.database, "trustbridge_test");
    assert.match(identity.version, /PostgreSQL 17\.10\b/);
    assert.equal(identity.port, 5432);
    assert.ok(["::1/128", "::1", "127.0.0.1/32", "127.0.0.1"].includes(identity.address));

    await t.test("profile JSON preferences persist and responses remain safe", async () => {
      const userId = await createUser();
      const result = await service.updateMe({ auth: { userId, authVersion: 0 }, input: { displayName: "Updated", preferences: { locale: "en-GB" }, notificationPreferences: { email: false } } });
      assert.equal(result.profile.displayName, "Updated");
      assert.deepEqual(result.profile.preferences, { locale: "en-GB" });
      assert.deepEqual(result.profile.notificationPreferences, { email: false });
      assert.equal(Object.hasOwn(result, "passwordHash"), false);
    });

    await t.test("password change increments authVersion, revokes sessions and audits atomically", async () => {
      const userId = await createUser();
      const { auth } = await authFor(userId);
      await service.changePassword({ auth, currentPassword: "current password", newPassword: "next password", requestId: `pg-test-${randomUUID()}` });
      const [user, session, audit] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.refreshToken.findUnique({ where: { id: auth.sessionId } }),
        prisma.auditLog.findFirst({ where: { actorUserId: userId, action: "USER_PASSWORD_CHANGED" } }),
      ]);
      assert.equal(user.authVersion, 1);
      assert.equal(user.passwordHash, "test-only-password-hash-after-change");
      assert.ok(session.revokedAt instanceof Date);
      assert.ok(audit);
    });

    await t.test("user deactivation advances authVersion and revokes sessions", async () => {
      const userId = await createUser();
      const { auth } = await authFor(userId);
      await service.deactivateMe({ auth, requestId: `pg-test-${randomUUID()}` });
      const [user, session, audit] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.refreshToken.findUnique({ where: { id: auth.sessionId } }),
        prisma.auditLog.findFirst({ where: { actorUserId: userId, action: "USER_ACCOUNT_DEACTIVATED" } }),
      ]);
      assert.equal(user.status, "DEACTIVATED");
      assert.equal(user.authVersion, 1);
      assert.ok(session.revokedAt instanceof Date);
      assert.ok(audit);
    });

    await t.test("ADMIN status change requires persisted MFA session and revokes target sessions", async () => {
      const adminId = await createUser({ role: "ADMIN", mfa: true });
      const targetId = await createUser();
      const { auth } = await authFor(adminId, { mfa: true });
      const targetSession = await sessions.issueForUser(targetId);
      const targetSessionRow = await prisma.refreshToken.findFirst({ where: { userId: targetId }, orderBy: { createdAt: "desc" } });
      const result = await service.updateUserStatus({ auth, targetUserId: targetId, status: "SUSPENDED", reasonCode: "PG_TEST", requestId: `pg-test-${randomUUID()}` });
      const [target, persistedSession, audit] = await Promise.all([
        prisma.user.findUnique({ where: { id: targetId } }),
        prisma.refreshToken.findUnique({ where: { id: targetSessionRow.id } }),
        prisma.auditLog.findFirst({ where: { actorUserId: adminId, entityId: targetId, action: "ADMIN_USER_STATUS_CHANGED" } }),
      ]);
      assert.equal(result.user.status, "SUSPENDED");
      assert.equal(target.authVersion, 1);
      assert.ok(persistedSession.revokedAt instanceof Date);
      assert.ok(audit);
      assert.ok(targetSession.refreshToken);
    });

    await t.test("audit failure rolls back ADMIN status and session revocation", async () => {
      const adminId = await createUser({ role: "ADMIN", mfa: true });
      const targetId = await createUser();
      const { auth } = await authFor(adminId, { mfa: true });
      await sessions.issueForUser(targetId);
      const targetSession = await prisma.refreshToken.findFirst({ where: { userId: targetId }, orderBy: { createdAt: "desc" } });
      const suffix = randomUUID().replaceAll("-", "");
      const name = `tb036_fail_${suffix}`;
      await catalog.query(`CREATE FUNCTION public."${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ADMIN_USER_STATUS_CHANGED' THEN RAISE EXCEPTION 'injected test failure'; END IF; RETURN NEW; END $$`);
      await catalog.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public."${name}"()`);
      trigger = { name };
      await assert.rejects(service.updateUserStatus({ auth, targetUserId: targetId, status: "SUSPENDED", reasonCode: "PG_ROLLBACK", requestId: `pg-test-${randomUUID()}` }), (error) => error instanceof UserServiceError && error.code === "USER_STORAGE_UNAVAILABLE");
      await catalog.query(`DROP TRIGGER IF EXISTS "${name}" ON public.audit_logs`);
      await catalog.query(`DROP FUNCTION IF EXISTS public."${name}"()`);
      trigger = null;
      const [target, session, audit] = await Promise.all([
        prisma.user.findUnique({ where: { id: targetId } }),
        prisma.refreshToken.findUnique({ where: { id: targetSession.id } }),
        prisma.auditLog.findFirst({ where: { entityId: targetId, action: "ADMIN_USER_STATUS_CHANGED" } }),
      ]);
      assert.equal(target.status, "ACTIVE");
      assert.equal(target.authVersion, 0);
      assert.equal(session.revokedAt, null);
      assert.equal(audit, null);
    });

    await t.test("concurrent password change and deactivation serialize on authVersion", async () => {
      const userId = await createUser();
      const { auth } = await authFor(userId);
      let arrived = 0;
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const gate = async () => { arrived += 1; if (arrived === 2) release(); await barrier; };
      const first = gatedService(prisma, gate);
      const second = gatedService(secondPrisma, gate);
      const outcomes = await Promise.allSettled([
        first.changePassword({ auth, currentPassword: "current password", newPassword: "next password", requestId: `pg-test-${randomUUID()}` }),
        second.deactivateMe({ auth, requestId: `pg-test-${randomUUID()}` }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      const [user, session, passwordAudits, deactivationAudits] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId } }),
        prisma.refreshToken.findUnique({ where: { id: auth.sessionId } }),
        prisma.auditLog.count({ where: { actorUserId: userId, action: "USER_PASSWORD_CHANGED" } }),
        prisma.auditLog.count({ where: { actorUserId: userId, action: "USER_ACCOUNT_DEACTIVATED" } }),
      ]);
      assert.equal(user.authVersion, 1);
      assert.ok(["ACTIVE", "DEACTIVATED"].includes(user.status));
      assert.ok(session.revokedAt instanceof Date);
      assert.equal(passwordAudits + deactivationAudits, 1);
    });
  } finally {
    await cleanup();
    await catalog.end();
    await secondPrisma.$disconnect();
    await prisma.$disconnect();
  }
});
