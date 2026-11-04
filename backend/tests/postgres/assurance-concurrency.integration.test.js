import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl, validateEnv } from "../../src/config/env.js";
import { createAuthenticationMiddleware } from "../../src/middleware/auth.middleware.js";
import { createStepUpAuthorizationMiddleware } from "../../src/middleware/recentMfa.middleware.js";
import { createMfaPersistenceService, MfaPersistenceError } from "../../src/services/mfa-persistence.service.js";
import { createSessionService } from "../../src/services/session.service.js";
import { DEFAULT_STEP_UP_PURPOSES } from "../../src/services/step-up-purpose.registry.js";
import { verifyAccessToken } from "../../src/utils/jwt.js";

const enabled = process.env.TRUSTBRIDGE_PG_TESTS === "1";

test("PostgreSQL assurance and MFA concurrency integration", { skip: !enabled }, async (t) => {
  const developmentUrl = new URL(getDatabaseUrl());
  assert.equal(developmentUrl.hostname, "localhost");
  assert.equal(developmentUrl.port || "5432", "5432");
  assert.equal(developmentUrl.pathname, "/Trustbridge");
  const testUrl = new URL(developmentUrl);
  testUrl.pathname = "/trustbridge_test";
  process.env.DATABASE_URL = testUrl.toString();
  const environment = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: testUrl.toString(),
    JWT_ACCESS_SECRET: "postgres-test-access-secret-value-0123456789",
    JWT_REFRESH_SECRET: "postgres-test-refresh-secret-value-9876543210",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "7d",
    JWT_ISSUER: "trustbridge-pg-tests",
    JWT_AUDIENCE: "trustbridge-pg-test-client",
  });
  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([
    import("../../generated/prisma/client.ts"),
    import("@prisma/adapter-pg"),
    import("pg"),
  ]);
  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const clients = [makeClient(), makeClient()];
  const [a, b] = clients;
  let trigger = null;
  const userIds = new Set();
  const now = () => new Date();
  const encryption = {
    encrypt: async () => ({ ciphertext: Buffer.from("ciphertext"), nonce: Buffer.alloc(12, 2), authTag: Buffer.alloc(16, 3), keyId: "pg-test-key", keyVersion: 1 }),
    decrypt: async () => "not-used-by-these-cases",
  };
  const liveEnvironment = {
    jwt: { refreshTtl: "7d", accessTtl: "15m", accessSecret: "postgres-test-access-secret-value-0123456789", algorithm: "HS256", issuer: "trustbridge-pg-tests", audience: "trustbridge-pg-test-client" },
  };
  const barrier = (parties = 2) => {
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return async () => { arrived += 1; if (arrived === parties) release(); await gate; };
  };
  const clientAtGate = (client, gate) => ({
    user: client.user,
    refreshToken: client.refreshToken,
    mfaChallenge: client.mfaChallenge,
    mfaRecoveryCode: client.mfaRecoveryCode,
    userMfa: client.userMfa,
    accountRecoveryRequest: client.accountRecoveryRequest,
    recoveryApproval: client.recoveryApproval,
    auditLog: client.auditLog,
    $transaction: async (...args) => { await gate(); return client.$transaction(...args); },
  });
  const createUser = async ({ mfa = false } = {}) => {
    const id = randomUUID();
    userIds.add(id);
    await a.user.create({ data: { id, email: `${id}@pg-test.invalid`, passwordHash: "test-only-not-a-real-password-hash", role: "USER", status: "ACTIVE", authVersion: 0 } });
    let enabledAt = null;
    if (mfa) {
      enabledAt = new Date(Date.now() - 60_000);
      await a.userMfa.create({ data: {
        userId: id, enrollmentStatus: "ENABLED", secretCiphertext: Buffer.from("ciphertext"),
        secretNonce: Buffer.alloc(12, 2), secretAuthTag: Buffer.alloc(16, 3), secretKeyId: "pg-test-key", secretKeyVersion: 1,
        enabledAt,
      } });
    }
    return { id, enabledAt };
  };
  const cleanupUser = async (id) => {
    const requests = await a.accountRecoveryRequest.findMany({ where: { OR: [{ userId: id }, { requestedByUserId: id }] }, select: { id: true } });
    const requestIds = requests.map(({ id: requestId }) => requestId);
    if (requestIds.length) await a.recoveryApproval.deleteMany({ where: { requestId: { in: requestIds } } });
    await a.recoveryApproval.deleteMany({ where: { approverId: id } });
    await a.accountRecoveryRequest.deleteMany({ where: { OR: [{ userId: id }, { requestedByUserId: id }] } });
    await a.mfaChallenge.deleteMany({ where: { userId: id } });
    await a.mfaRecoveryCode.deleteMany({ where: { userId: id } });
    await a.refreshToken.deleteMany({ where: { userId: id } });
    await a.auditLog.deleteMany({ where: { actorUserId: id } });
    await a.userMfa.deleteMany({ where: { userId: id } });
    await a.user.deleteMany({ where: { id } });
  };
  const sessionsFor = (client) => createSessionService({ getClient: async () => client, environment: liveEnvironment, now });
  const createPersist = (client, overrides = {}) => createMfaPersistenceService({ getClient: async () => client, encryption, now, verifyTotp: async () => ({ valid: false }), ...overrides });
  const db = new Client({ connectionString: testUrl.toString() });
  const addFailTrigger = async ({ table, operation, condition }) => {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `tb_test_fail_${suffix}`;
    const triggerName = `tb_test_fail_${suffix}`;
    const allowed = new Set(["audit_logs", "refresh_tokens", "mfa_challenges"]);
    assert.ok(allowed.has(table));
    await db.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected integration-test failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER "${triggerName}" BEFORE ${operation} ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    trigger = { table, triggerName, functionName };
  };
  const removeFailTrigger = async () => {
    if (!trigger) return;
    await db.query(`DROP TRIGGER IF EXISTS "${trigger.triggerName}" ON public."${trigger.table}"`);
    await db.query(`DROP FUNCTION IF EXISTS public."${trigger.functionName}"()`);
    trigger = null;
  };

  try {
    for (const client of clients) await client.$connect();
    await db.connect();
    const identity = (await db.query("SELECT current_database() AS database, version() AS version, inet_server_addr()::text AS address, inet_server_port() AS port")).rows[0];
    assert.equal(identity.database, "trustbridge_test");
    assert.match(identity.version, /PostgreSQL 17\.10\b/);
    assert.equal(identity.port, 5432);
    assert.ok(["::1/128", "::1", "127.0.0.1/32", "127.0.0.1"].includes(identity.address));
    const [pidA, pidB] = await Promise.all([
      a.$queryRaw`SELECT pg_backend_pid() AS pid`,
      b.$queryRaw`SELECT pg_backend_pid() AS pid`,
    ]);
    assert.notEqual(pidA[0].pid, pidB[0].pid, "concurrent test clients must use separate PostgreSQL backend connections");

    await t.test("concurrent refresh rotation has one winner and replay revokes family", async () => {
      const user = await createUser();
      const issued = await sessionsFor(a).issueForUser(user.id);
      const gate = barrier();
      const outcomes = await Promise.allSettled([
        sessionsFor(clientAtGate(a, gate)).refresh(issued.refreshToken),
        sessionsFor(clientAtGate(b, gate)).refresh(issued.refreshToken),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      const rows = await a.refreshToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.revokedAt instanceof Date), "replay detection should revoke original and replacement family sessions");
      assert.equal(await a.refreshToken.count({ where: { userId: user.id, revokedAt: null } }), 0);
    });

    await t.test("concurrent recovery-code use consumes exactly once", async () => {
      const user = await createUser();
      const code = "C".repeat(32);
      const codeHash = createHash("sha256").update(code).digest("hex");
      const recovery = await a.mfaRecoveryCode.create({ data: { userId: user.id, batchId: randomUUID(), codeHash } });
      const gate = barrier();
      const outcomes = await Promise.allSettled([
        createPersist(clientAtGate(a, gate)).consumeRecoveryCode({ userId: user.id, code }),
        createPersist(clientAtGate(b, gate)).consumeRecoveryCode({ userId: user.id, code }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled" && result.value === true).length, 1);
      const stored = await a.mfaRecoveryCode.findUnique({ where: { id: recovery.id } });
      assert.ok(stored.consumedAt instanceof Date);
      assert.equal(await a.mfaRecoveryCode.count({ where: { id: recovery.id, consumedAt: { not: null } } }), 1);
    });

    await t.test("concurrent recovery-code login consumes the code and login challenge atomically once", async () => {
      const user = await createUser({ mfa: true });
      const code = "F".repeat(32);
      await a.mfaRecoveryCode.create({ data: { userId: user.id, batchId: randomUUID(), codeHash: createHash("sha256").update(code).digest("hex") } });
      const challengeToken = await createPersist(a).createChallenge({ userId: user.id, purpose: "LOGIN", authVersion: 0, expiresAt: new Date(Date.now() + 300_000) });
      const gate = barrier();
      const outcomes = await Promise.allSettled([
        createPersist(clientAtGate(a, gate)).completeLoginChallenge({ token: challengeToken, code }),
        createPersist(clientAtGate(b, gate)).completeLoginChallenge({ token: challengeToken, code }),
      ]);
      const successful = outcomes.filter((result) => result.status === "fulfilled" && result.value);
      assert.equal(successful.length, 1);
      assert.equal(successful.filter((result) => result.value.assuranceLevel === "RECOVERY_CODE_VERIFIED" && result.value.mfaVerifiedAt === null).length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected" || result.value === null).length, 1);
      assert.equal(await a.mfaRecoveryCode.count({ where: { userId: user.id, consumedAt: { not: null } } }), 1);
      assert.equal(await a.mfaChallenge.count({ where: { userId: user.id, consumedAt: { not: null } } }), 1);
    });

    await t.test("concurrent recovery-code regeneration leaves exactly one valid batch", async () => {
      const user = await createUser({ mfa: true });
      const issuedAt = new Date();
      await sessionsFor(a).issueForUser(user.id, { mfaVerifiedAt: issuedAt, expectedAuthVersion: 0 });
      const session = await a.refreshToken.findFirst({ where: { userId: user.id }, select: { id: true } });
      const firstCode = "E".repeat(32);
      await a.mfaRecoveryCode.createMany({ data: Array.from({ length: 10 }, (_, index) => ({ userId: user.id, batchId: randomUUID(), codeHash: createHash("sha256").update(`${firstCode}${index}`).digest("hex") })) });
      const gate = barrier();
      const input = { userId: user.id, sessionId: session.id, authVersion: 0, mfaVerifiedAt: issuedAt };
      const outcomes = await Promise.allSettled([
        createPersist(clientAtGate(a, gate)).createRecoveryCodeBatch(input),
        createPersist(clientAtGate(b, gate)).createRecoveryCodeBatch(input),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 2);
      const active = await a.mfaRecoveryCode.findMany({ where: { userId: user.id, consumedAt: null, invalidatedAt: null } });
      assert.equal(active.length, 10);
      assert.equal(new Set(active.map((row) => row.batchId)).size, 1);
      const inactive = await a.mfaRecoveryCode.count({ where: { userId: user.id, invalidatedAt: { not: null } } });
      assert.equal(inactive, 20);
      assert.ok(outcomes.every((result) => result.value.codes.length === 10));
      assert.ok(active.every((row) => !Object.hasOwn(row, "code")));
    });

    await t.test("concurrent independent ADMIN recovery approvals reach two-person approval once", async () => {
      const subject = await createUser();
      const admin1 = await createUser({ mfa: true });
      const admin2 = await createUser({ mfa: true });
      await a.user.update({ where: { id: admin1.id }, data: { role: "ADMIN" } });
      await a.user.update({ where: { id: admin2.id }, data: { role: "ADMIN" } });
      const request = await a.accountRecoveryRequest.create({ data: { userId: subject.id, expiresAt: new Date(Date.now() + 300_000), identityVerifiedAt: new Date(), identityVerificationRef: "pg-test-opaque-verification-reference" } });
      const gate = barrier();
      const outcomes = await Promise.allSettled([
        createPersist(clientAtGate(a, gate)).recordRecoveryApproval({ requestId: request.id, approverId: admin1.id, decision: "APPROVE", reasonCode: "TEST_REVIEW" }),
        createPersist(clientAtGate(b, gate)).recordRecoveryApproval({ requestId: request.id, approverId: admin2.id, decision: "APPROVE", reasonCode: "TEST_REVIEW" }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 2);
      assert.equal(await a.recoveryApproval.count({ where: { requestId: request.id, decision: "APPROVE" } }), 2);
      assert.equal((await a.accountRecoveryRequest.findUnique({ where: { id: request.id } })).status, "APPROVED");
      await assert.rejects(createPersist(a).recordRecoveryApproval({ requestId: request.id, approverId: admin1.id, decision: "APPROVE" }), MfaPersistenceError);
      await assert.rejects(createPersist(a).recordRecoveryApproval({ requestId: request.id, approverId: subject.id, decision: "APPROVE" }), { code: "MFA_RECOVERY_APPROVAL_DENIED" });
    });

    await t.test("approved legacy ADMIN enrollment is short-lived, single-use, audited and invalidates old sessions", async () => {
      const target = await createUser();
      await a.user.update({ where: { id: target.id }, data: { role: "ADMIN" } });
      const staleSession = await a.refreshToken.create({ data: {
        userId: target.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), familyId: randomUUID(),
        authVersion: 0, assuranceLevel: "PASSWORD_ONLY", expiresAt: new Date(Date.now() + 300_000),
      }, select: { id: true } });
      const staleGrantTime = new Date(Date.now() - 1_000);
      const staleGrant = await a.mfaChallenge.create({ data: {
        userId: target.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), purpose: "STEP_UP",
        operationPurpose: "MFA_RECOVERY_CODES_REGENERATE", authVersion: 0, expiresAt: new Date(Date.now() + 300_000),
        sessionId: staleSession.id, resourceType: "USER", resourceId: target.id, mfaEnabledAt: staleGrantTime,
        verifiedAt: staleGrantTime, consumedAt: staleGrantTime,
      } });
      const admin1 = await createUser({ mfa: true });
      const admin2 = await createUser({ mfa: true });
      await a.user.update({ where: { id: admin1.id }, data: { role: "ADMIN" } });
      await a.user.update({ where: { id: admin2.id }, data: { role: "ADMIN" } });
      const request = await a.accountRecoveryRequest.create({ data: { userId: target.id, status: "APPROVED", expiresAt: new Date(Date.now() + 300_000), identityVerifiedAt: new Date(), identityVerificationRef: "opaque-verified-reference" } });
      await a.recoveryApproval.createMany({ data: [admin1, admin2].map(({ id }) => ({ requestId: request.id, approverId: id, decision: "APPROVE" })) });
      let deliveredToken;
      const service = (client) => createPersist(client, {
        verifyTotp: async () => ({ valid: true, timeStep: 123456 }),
        deliverLegacyAdminEnrollmentAuthorization: async ({ userId, authorizationToken }) => { assert.equal(userId, target.id); deliveredToken = authorizationToken; },
      });
      const issueGate = barrier();
      const issueResults = await Promise.allSettled([
        createPersist(clientAtGate(a, issueGate), { verifyTotp: async () => ({ valid: false }), deliverLegacyAdminEnrollmentAuthorization: async ({ userId, authorizationToken }) => { assert.equal(userId, target.id); deliveredToken = authorizationToken; } }).issueLegacyAdminEnrollmentAuthorization({ requestId: request.id, issuedByUserId: admin1.id }),
        createPersist(clientAtGate(b, issueGate), { verifyTotp: async () => ({ valid: false }), deliverLegacyAdminEnrollmentAuthorization: async ({ userId, authorizationToken }) => { assert.equal(userId, target.id); deliveredToken = authorizationToken; } }).issueLegacyAdminEnrollmentAuthorization({ requestId: request.id, issuedByUserId: admin2.id }),
      ]);
      assert.equal(issueResults.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(issueResults.filter((result) => result.status === "rejected").length, 1);
      assert.equal(typeof deliveredToken, "string");
      const storedChallenge = await a.mfaChallenge.findFirst({ where: { userId: target.id, purpose: "LEGACY_ADMIN_MFA_ENROLL" } });
      assert.equal(storedChallenge.purpose, "LEGACY_ADMIN_MFA_ENROLL");
      assert.equal(storedChallenge.tokenHash, createHash("sha256").update(deliveredToken).digest("hex"));
      assert.equal(storedChallenge.authVersion, 0);
      await assert.rejects(service(a).startLegacyAdminEnrollment({ token: `${deliveredToken}wrong`, secret: "secret" }), MfaPersistenceError);
      const enrollment = await service(a).startLegacyAdminEnrollment({ token: deliveredToken, secret: "test-enrollment-secret" });
      assert.equal(enrollment.email, `${target.id}@pg-test.invalid`);
      await assert.rejects(service(a).startLegacyAdminEnrollment({ token: deliveredToken, secret: "replacement-secret" }), MfaPersistenceError);
      await addFailTrigger({ table: "audit_logs", operation: "INSERT", condition: "NEW.action = 'LEGACY_ADMIN_MFA_ENROLLMENT_COMPLETED'" });
      await assert.rejects(service(a).activateLegacyAdminEnrollment({ token: enrollment.verificationToken, code: "123456" }), MfaPersistenceError);
      await removeFailTrigger();
      assert.equal((await a.user.findUnique({ where: { id: target.id } })).authVersion, 0);
      assert.equal((await a.userMfa.findUnique({ where: { userId: target.id } })).enrollmentStatus, "PENDING");
      assert.equal((await a.refreshToken.findUnique({ where: { id: staleSession.id } })).revokedAt, null);
      const gate = barrier();
      const outcomes = await Promise.allSettled([
        service(clientAtGate(a, gate)).activateLegacyAdminEnrollment({ token: enrollment.verificationToken, code: "123456" }),
        service(clientAtGate(b, gate)).activateLegacyAdminEnrollment({ token: enrollment.verificationToken, code: "123456" }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      assert.equal((await a.userMfa.findUnique({ where: { userId: target.id } })).enrollmentStatus, "ENABLED");
      assert.equal((await a.user.findUnique({ where: { id: target.id } })).authVersion, 1);
      assert.ok((await a.refreshToken.findUnique({ where: { id: staleSession.id } })).revokedAt instanceof Date);
      assert.ok((await a.mfaChallenge.findUnique({ where: { id: storedChallenge.id } })).consumedAt instanceof Date);
      assert.ok((await a.mfaChallenge.findUnique({ where: { id: staleGrant.id } })).expiresAt <= new Date());
      assert.equal(await a.mfaRecoveryCode.count({ where: { userId: target.id, consumedAt: null, invalidatedAt: null } }), 10);
      await assert.rejects(service(a).activateLegacyAdminEnrollment({ token: enrollment.verificationToken, code: "123456" }), MfaPersistenceError);

      const expiredTarget = await createUser();
      await a.user.update({ where: { id: expiredTarget.id }, data: { role: "ADMIN" } });
      const expiredRequest = await a.accountRecoveryRequest.create({ data: { userId: expiredTarget.id, status: "APPROVED", expiresAt: new Date(Date.now() + 300_000), identityVerifiedAt: new Date(), identityVerificationRef: "opaque-verified-reference" } });
      await a.recoveryApproval.createMany({ data: [admin1, admin2].map(({ id }) => ({ requestId: expiredRequest.id, approverId: id, decision: "APPROVE" })) });
      let expiredAuthorization;
      const expiryService = createPersist(a, { deliverLegacyAdminEnrollmentAuthorization: async ({ authorizationToken }) => { expiredAuthorization = authorizationToken; } });
      await expiryService.issueLegacyAdminEnrollmentAuthorization({ requestId: expiredRequest.id, issuedByUserId: admin1.id });
      await a.mfaChallenge.updateMany({ where: { userId: expiredTarget.id, purpose: "LEGACY_ADMIN_MFA_ENROLL" }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      await assert.rejects(expiryService.startLegacyAdminEnrollment({ token: expiredAuthorization, secret: "expired-secret" }), MfaPersistenceError);
    });

    await t.test("TOTP-authorized MFA disablement revokes sessions, recovery codes and advances authVersion", async () => {
      const user = await createUser({ mfa: true });
      const issuedAt = new Date();
      const issued = await sessionsFor(a).issueForUser(user.id, { mfaVerifiedAt: issuedAt, expectedAuthVersion: 0 });
      await a.mfaRecoveryCode.create({ data: { userId: user.id, batchId: randomUUID(), codeHash: createHash("sha256").update(randomUUID()).digest("hex") } });
      const session = await a.refreshToken.findFirst({ where: { userId: user.id }, select: { id: true } });
      const result = await createPersist(a).disableMfa({ userId: user.id, sessionId: session.id, authVersion: 0 });
      assert.deepEqual(result, { disabled: true });
      assert.equal((await a.userMfa.findUnique({ where: { userId: user.id } })).enrollmentStatus, "DISABLED");
      assert.equal((await a.user.findUnique({ where: { id: user.id } })).authVersion, 1);
      assert.equal(await a.refreshToken.count({ where: { userId: user.id, revokedAt: null } }), 0);
      assert.equal(await a.mfaRecoveryCode.count({ where: { userId: user.id, invalidatedAt: { not: null } } }), 1);
      assert.ok(issued.accessToken);
    });

    await t.test("recovery batch replacement and account recovery completion roll back atomically on audit failure", async () => {
      const target = await createUser({ mfa: true });
      const issuedAt = new Date();
      await sessionsFor(a).issueForUser(target.id, { mfaVerifiedAt: issuedAt, expectedAuthVersion: 0 });
      const session = await a.refreshToken.findFirst({ where: { userId: target.id }, select: { id: true } });
      const existingCode = await a.mfaRecoveryCode.create({ data: { userId: target.id, batchId: randomUUID(), codeHash: createHash("sha256").update(randomUUID()).digest("hex") } });
      await addFailTrigger({ table: "audit_logs", operation: "INSERT", condition: "NEW.action = 'MFA_RECOVERY_CODES_REGENERATED'" });
      await assert.rejects(createPersist(a).createRecoveryCodeBatch({ userId: target.id, sessionId: session.id, authVersion: 0, mfaVerifiedAt: issuedAt }), MfaPersistenceError);
      await removeFailTrigger();
      assert.equal((await a.mfaRecoveryCode.findUnique({ where: { id: existingCode.id } })).invalidatedAt, null);
      assert.equal(await a.mfaRecoveryCode.count({ where: { userId: target.id } }), 1);

      const admin1 = await createUser({ mfa: true });
      const admin2 = await createUser({ mfa: true });
      const operator = await createUser({ mfa: true });
      for (const admin of [admin1, admin2, operator]) await a.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });
      const request = await a.accountRecoveryRequest.create({ data: { userId: target.id, status: "APPROVED", identityVerifiedAt: new Date(), identityVerificationRef: "pg-test-opaque-reference", expiresAt: new Date(Date.now() + 300_000) } });
      await a.recoveryApproval.createMany({ data: [admin1, admin2].map(({ id }) => ({ requestId: request.id, approverId: id, decision: "APPROVE" })) });
      await addFailTrigger({ table: "audit_logs", operation: "INSERT", condition: "NEW.action = 'ACCOUNT_RECOVERY_COMPLETED'" });
      await assert.rejects(createPersist(a).completeAccountRecovery({ requestId: request.id, completedByUserId: operator.id }), MfaPersistenceError);
      await removeFailTrigger();
      assert.equal((await a.accountRecoveryRequest.findUnique({ where: { id: request.id } })).status, "APPROVED");
      assert.equal((await a.userMfa.findUnique({ where: { userId: target.id } })).enrollmentStatus, "ENABLED");
      assert.equal((await a.user.findUnique({ where: { id: target.id } })).authVersion, 0);
      assert.equal((await a.mfaRecoveryCode.findUnique({ where: { id: existingCode.id } })).invalidatedAt, null);
      assert.deepEqual(await createPersist(a).completeAccountRecovery({ requestId: request.id, completedByUserId: operator.id }), { status: "COMPLETED", mfaReset: true });
      assert.equal((await a.accountRecoveryRequest.findUnique({ where: { id: request.id } })).status, "COMPLETED");
      assert.equal((await a.userMfa.findUnique({ where: { userId: target.id } })).enrollmentStatus, "DISABLED");
      assert.equal((await a.user.findUnique({ where: { id: target.id } })).authVersion, 1);
      assert.equal(await a.refreshToken.count({ where: { userId: target.id, revokedAt: null } }), 0);
      assert.ok((await a.mfaRecoveryCode.findUnique({ where: { id: existingCode.id } })).invalidatedAt instanceof Date);
    });

    await t.test("concurrent one-time step-up grant consumption changes grantConsumedAt only once", async () => {
      const user = await createUser({ mfa: true });
      const issuedAt = new Date();
      const session = await sessionsFor(a).issueForUser(user.id, { mfaVerifiedAt: issuedAt, expectedAuthVersion: 0 });
      const sessionId = (await a.refreshToken.findFirst({ where: { userId: user.id }, select: { id: true } })).id;
      const verifiedAt = new Date();
      const grant = await a.mfaChallenge.create({ data: {
        userId: user.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), purpose: "STEP_UP",
        operationPurpose: "MFA_RECOVERY_CODES_REGENERATE", authVersion: 0, expiresAt: new Date(Date.now() + 60_000),
        consumedAt: verifiedAt, verifiedAt, sessionId, resourceType: "USER", resourceId: user.id, mfaEnabledAt: user.enabledAt,
      } });
      const auth = { userId: user.id, role: "USER", authVersion: 0, sessionId, mfaEnabled: true, mfaVerifiedAt: issuedAt, assuranceLevel: "TOTP_VERIFIED" };
      const gate = barrier();
      const invoke = (client) => new Promise((resolve) => createStepUpAuthorizationMiddleware({
        purpose: "MFA_RECOVERY_CODES_REGENERATE", resourceId: user.id, purposeRegistry: DEFAULT_STEP_UP_PURPOSES,
        getClient: async () => clientAtGate(client, gate), now,
      })({ auth, params: {} }, {}, (error) => resolve(error ?? null)));
      const results = await Promise.all([invoke(a), invoke(b)]);
      assert.equal(results.filter((value) => value === null).length, 1);
      assert.equal(results.filter(Boolean).length, 1);
      const updated = await a.mfaChallenge.findUnique({ where: { id: grant.id } });
      assert.equal(updated.consumedAt.getTime(), verifiedAt.getTime());
      assert.ok(updated.grantConsumedAt instanceof Date);
      assert.equal(await a.mfaChallenge.count({ where: { id: grant.id, grantConsumedAt: { not: null } } }), 1);
    });

    await t.test("replaced MFA enrollment invalidates old grants and sessions", async () => {
      const user = await createUser({ mfa: true });
      const issuedAt = new Date();
      const issued = await sessionsFor(a).issueForUser(user.id, { mfaVerifiedAt: issuedAt });
      const session = await a.refreshToken.findFirst({ where: { userId: user.id } });
      const grant = await a.mfaChallenge.create({ data: {
        userId: user.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), purpose: "STEP_UP",
        operationPurpose: "MFA_RECOVERY_CODES_REGENERATE", authVersion: 0, expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(), verifiedAt: new Date(), sessionId: session.id, resourceType: "USER", resourceId: user.id, mfaEnabledAt: user.enabledAt,
      } });
      await a.userMfa.update({ where: { userId: user.id }, data: { enabledAt: new Date(Date.now() + 60_000) } });
      const auth = { userId: user.id, role: "USER", authVersion: 0, sessionId: session.id, mfaEnabled: true, mfaVerifiedAt: issuedAt, assuranceLevel: "TOTP_VERIFIED" };
      const error = await new Promise((resolve) => createStepUpAuthorizationMiddleware({ purpose: "MFA_RECOVERY_CODES_REGENERATE", resourceId: user.id, getClient: async () => a, now })({ auth, params: {} }, {}, resolve));
      assert.equal(error.code, "MFA_ASSURANCE_REQUIRED");
      const staleAuth = createAuthenticationMiddleware({ getClient: async () => a, verify: (token) => verifyAccessToken(token, { environment }), now: () => new Date(Date.now() + 120_000) });
      const req = { get: () => `Bearer ${issued.accessToken}` };
      const authError = await new Promise((resolve) => staleAuth(req, {}, resolve));
      assert.equal(authError.statusCode, 401);
      await assert.rejects(sessionsFor(a).refresh(issued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });
      assert.equal((await a.mfaChallenge.findUnique({ where: { id: grant.id } })).grantConsumedAt, null);
    });

    await t.test("authVersion changes reject both access and refresh sessions", async () => {
      const user = await createUser();
      const issued = await sessionsFor(a).issueForUser(user.id);
      await a.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } });
      const auth = createAuthenticationMiddleware({ getClient: async () => a, verify: (token) => verifyAccessToken(token, { environment }), now });
      const error = await new Promise((resolve) => auth({ get: () => `Bearer ${issued.accessToken}` }, {}, resolve));
      assert.equal(error.statusCode, 401);
      await assert.rejects(sessionsFor(a).refresh(issued.refreshToken), { code: "INVALID_REFRESH_TOKEN" });
    });

    await t.test("transaction failures roll back recovery consumption, grant consumption and refresh rotation", async () => {
      const recoveryUser = await createUser();
      const recoveryCode = "D".repeat(32);
      const recoveryRecord = await a.mfaRecoveryCode.create({ data: { userId: recoveryUser.id, batchId: randomUUID(), codeHash: createHash("sha256").update(recoveryCode).digest("hex") } });
      await addFailTrigger({ table: "audit_logs", operation: "INSERT", condition: "NEW.action = 'MFA_RECOVERY_CODE_CONSUMED'" });
      await assert.rejects(createPersist(a).consumeRecoveryCode({ userId: recoveryUser.id, code: recoveryCode }), MfaPersistenceError);
      await removeFailTrigger();
      assert.equal((await a.mfaRecoveryCode.findUnique({ where: { id: recoveryRecord.id } })).consumedAt, null);

      const loginUser = await createUser({ mfa: true });
      const loginRecoveryCode = "B".repeat(32);
      const loginRecord = await a.mfaRecoveryCode.create({ data: { userId: loginUser.id, batchId: randomUUID(), codeHash: createHash("sha256").update(loginRecoveryCode).digest("hex") } });
      const challengeToken = await createPersist(a).createChallenge({ userId: loginUser.id, purpose: "LOGIN", authVersion: 0, expiresAt: new Date(Date.now() + 300_000) });
      await addFailTrigger({ table: "audit_logs", operation: "INSERT", condition: "NEW.action = 'MFA_RECOVERY_CODE_CONSUMED'" });
      await assert.rejects(createPersist(a).completeLoginChallenge({ token: challengeToken, code: loginRecoveryCode }), MfaPersistenceError);
      await removeFailTrigger();
      assert.equal((await a.mfaRecoveryCode.findUnique({ where: { id: loginRecord.id } })).consumedAt, null);
      assert.equal(await a.mfaChallenge.count({ where: { userId: loginUser.id, consumedAt: { not: null } } }), 0);

      const grantUser = await createUser({ mfa: true });
      const issuedAt = new Date();
      await sessionsFor(a).issueForUser(grantUser.id, { mfaVerifiedAt: issuedAt });
      const session = await a.refreshToken.findFirst({ where: { userId: grantUser.id } });
      const challenge = await a.mfaChallenge.create({ data: {
        userId: grantUser.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), purpose: "STEP_UP",
        operationPurpose: "MFA_RECOVERY_CODES_REGENERATE", authVersion: 0, expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(), verifiedAt: new Date(), sessionId: session.id, resourceType: "USER", resourceId: grantUser.id, mfaEnabledAt: grantUser.enabledAt,
      } });
      await addFailTrigger({ table: "mfa_challenges", operation: "UPDATE", condition: "NEW.grant_consumed_at IS NOT NULL AND OLD.grant_consumed_at IS NULL" });
      const auth = { userId: grantUser.id, role: "USER", authVersion: 0, sessionId: session.id, mfaEnabled: true, mfaVerifiedAt: issuedAt, assuranceLevel: "TOTP_VERIFIED" };
      const middlewareError = await new Promise((resolve) => createStepUpAuthorizationMiddleware({ purpose: "MFA_RECOVERY_CODES_REGENERATE", resourceId: grantUser.id, getClient: async () => a, now })({ auth, params: {} }, {}, resolve));
      await removeFailTrigger();
      assert.equal(middlewareError.code, "MFA_STEP_UP_UNAVAILABLE");
      const unchanged = await a.mfaChallenge.findUnique({ where: { id: challenge.id } });
      assert.equal(unchanged.grantConsumedAt, null);
      const originalMfaTimestamp = unchanged.consumedAt;

      const refreshUser = await createUser();
      const issued = await sessionsFor(a).issueForUser(refreshUser.id);
      await addFailTrigger({ table: "refresh_tokens", operation: "INSERT", condition: "NEW.rotated_from_id IS NOT NULL" });
      await assert.rejects(sessionsFor(a).refresh(issued.refreshToken));
      await removeFailTrigger();
      const original = await a.refreshToken.findFirst({ where: { userId: refreshUser.id } });
      assert.equal(original.revokedAt, null);
      assert.equal(await a.refreshToken.count({ where: { userId: refreshUser.id, rotatedFromId: original.id } }), 0);
      assert.ok(originalMfaTimestamp instanceof Date);
    });

    for (const id of userIds) await cleanupUser(id);
    const testUserIds = [...userIds];
    assert.equal(await a.user.count({ where: { id: { in: testUserIds } } }), 0, "all test users should be removed after their scenarios");
    assert.equal(await a.accountRecoveryRequest.count({ where: { OR: [{ userId: { in: testUserIds } }, { requestedByUserId: { in: testUserIds } }] } }), 0, "all test recovery requests should be removed");
    userIds.clear();
  } finally {
    await removeFailTrigger().catch(() => {});
    for (const id of userIds) await cleanupUser(id).catch(() => {});
    await db.end().catch(() => {});
    for (const client of clients) await client.$disconnect().catch(() => {});
  }
});
