import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createEscrowService } from "../../src/services/escrow.service.js";

const enabled = process.env.TRUSTBRIDGE_ESCROW_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_test";
assert.ok(["trustbridge_test", "trustbridge_tb050_clean"].includes(testDatabase), "only approved isolated PostgreSQL test databases are allowed");
test("isolated PostgreSQL serializes duplicate verified funding and preserves one balanced journal", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl());
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(baseline.hostname));
  assert.equal(baseline.port || "5432", "5432");
  assert.equal(baseline.pathname, "/Trustbridge");
  const testUrl = new URL(baseline); testUrl.pathname = `/${testDatabase}`;
  const [{ PrismaClient }, { PrismaPg }, { Client }, fs] = await Promise.all([
    import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg"), import("node:fs/promises"),
  ]);
  const catalog = new Client({ connectionString: testUrl.toString() });
  await catalog.connect();
  try {
    const identity = await catalog.query("SELECT current_database() AS database, current_setting('server_version') AS version, current_setting('port') AS port, inet_server_addr()::text AS server_address, inet_client_addr()::text AS client_address");
    const history = await catalog.query("SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name");
    const dirs = (await fs.readdir("./prisma/migrations", { withFileTypes: true })).filter((r) => r.isDirectory()).map((r) => r.name).sort();
    const row = identity.rows[0];
    const loopback = (ip) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(ip);
    assert.equal(row.database, testDatabase); assert.match(row.version, /^17\./); assert.equal(row.port, "5432");
    assert.ok(loopback(row.server_address)); assert.ok(loopback(row.client_address));
    assert.equal(history.rows.filter((m) => !m.finished_at && !m.rolled_back_at).length, 0);
    const applied = history.rows.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name).sort();
    assert.deepEqual(applied, dirs, "test DB must be fully migrated before this test runs");
  } finally { await catalog.end(); }

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const [a, b] = [makeClient(), makeClient()];
  const authUsers = new Set(); const authTransactions = new Set(); const preserveFinancialTransactions = new Set(); const preserveFinancialUsers = new Set();
  t.after(async () => {
    const ids = [...authTransactions].filter((id) => !preserveFinancialTransactions.has(id));
    if (ids.length) {
      await a.outboxEvent.deleteMany({ where: { transactionId: { in: ids } } });
      await a.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await a.transactionStatusHistory.deleteMany({ where: { transactionId: { in: ids } } });
      await a.deliveryDecision.deleteMany({ where: { delivery: { transactionId: { in: ids } } } });
      await a.transactionDelivery.deleteMany({ where: { transactionId: { in: ids } } });
      await a.escrowOperation.deleteMany({ where: { transactionId: { in: ids } } });
      await a.dispute.deleteMany({ where: { transactionId: { in: ids } } });
      await a.escrow.deleteMany({ where: { transactionId: { in: ids } } });
      await a.transactionParticipant.deleteMany({ where: { transactionId: { in: ids } } });
      await a.transaction.deleteMany({ where: { id: { in: ids } } });
    }
    const idsUsers = [...authUsers].filter((id) => !preserveFinancialUsers.has(id));
    if (idsUsers.length) { await a.refreshToken.deleteMany({ where: { userId: { in: idsUsers } } }); await a.userMfa.deleteMany({ where: { userId: { in: idsUsers } } }); await a.user.deleteMany({ where: { id: { in: idsUsers } } }); }
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });
  const userIds = [randomUUID(), randomUUID()];
  const transactionId = randomUUID(); const paymentAttemptId = randomUUID();
  for (const id of userIds) await a.user.create({ data: { id, email: `${id}@tb039-pg.invalid`, passwordHash: "test-only-placeholder-hash", status: "ACTIVE", role: "USER" } });
  await a.transaction.create({ data: { id: transactionId, buyerId: userIds[0], sellerId: userIds[1], createdById: userIds[0], status: "AWAITING_PAYMENT", amountMinor: 7700n, currency: "INR", terms: { test: true }, participants: { create: [{ userId: userIds[0], role: "BUYER" }, { userId: userIds[1], role: "SELLER" }] } } });
  await a.paymentAttempt.create({ data: { id: paymentAttemptId, transactionId, provider: "test-mock", providerReference: `ref-${paymentAttemptId}`, capturedPaymentId: `pay_${paymentAttemptId.slice(0, 10)}`, idempotencyKey: `id-${paymentAttemptId}`, status: "CAPTURED", amountMinor: 7700n, currency: "INR" } });
  const attempt = await a.paymentAttempt.findUnique({ where: { id: paymentAttemptId } });
  const results = await Promise.all([a, b].map((client) => {
    const service = createEscrowService({ getClient: async () => client });
    return client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE`;
      return service.recordVerifiedFunding({ tx, paymentAttempt: attempt });
    });
  }));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(await a.ledgerJournal.count({ where: { transactionId } }), 1);
  const journal = await a.ledgerJournal.findFirst({ where: { transactionId }, include: { entries: true } });
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.entries.reduce((sum, entry) => sum + (entry.direction === "DEBIT" ? entry.amountMinor : -entry.amountMinor), 0n), 0n);
  assert.equal((await a.transaction.findUnique({ where: { id: transactionId } })).status, "FUNDED");
  await assert.rejects(a.$transaction(async (tx) => {
    const unbalanced = await tx.ledgerJournal.create({ data: { transactionId, currency: "INR", operationId: `invalid-${randomUUID()}` } });
    const clearing = await tx.ledgerAccount.findUnique({ where: { transactionId_accountCode_currency: { transactionId, accountCode: "PROVIDER_CLEARING", currency: "INR" } } });
    await tx.ledgerEntry.create({ data: { journalId: unbalanced.id, transactionId, currency: "INR", accountId: clearing.id, amountMinor: 1n, direction: "DEBIT" } });
  }));
  assert.equal(await a.ledgerJournal.count({ where: { transactionId } }), 1, "deferred balance failure must roll back the invalid journal");
  const postedEntry = await a.ledgerEntry.findFirst({ where: { journalId: journal.id } });
  await assert.rejects(a.ledgerEntry.update({ where: { id: postedEntry.id }, data: { amountMinor: 2n } }));

  const makeTOTPUser = async (role) => {
    const id = randomUUID(); authUsers.add(id);
    await a.user.create({ data: { id, email: `${id}@tb039-pg.invalid`, passwordHash: "test-only-placeholder-hash", role, status: "ACTIVE" } });
    const enabledAt = new Date(Date.now() - 30_000);
    await a.userMfa.create({ data: { userId: id, enrollmentStatus: "ENABLED", enabledAt, secretCiphertext: Buffer.from([1]), secretNonce: Buffer.alloc(12, 1), secretAuthTag: Buffer.alloc(16, 1), secretKeyId: "integration-test", secretKeyVersion: 1 } });
    const sessionId = randomUUID();
    await a.refreshToken.create({ data: { id: sessionId, userId: id, tokenHash: randomUUID().replaceAll("-", ""), familyId: randomUUID(), authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) } });
    return { userId: id, role, authVersion: 0, sessionId, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() };
  };
  const makeRequestFixture = async ({ status, type, actor, resolution }) => {
    const buyer = type === "RELEASE" ? actor : await makeTOTPUser("USER");
    const seller = await makeTOTPUser("USER");
    const id = randomUUID(); authTransactions.add(id);
    await a.transaction.create({ data: { id, buyerId: buyer.userId, sellerId: seller.userId, createdById: buyer.userId, status, amountMinor: 3000n, currency: "INR", terms: { test: true }, participants: { create: [{ userId: buyer.userId, role: "BUYER" }, { userId: seller.userId, role: "SELLER" }] } } });
    if (type === "RELEASE") {
      const delivery = await a.transactionDelivery.create({ data: { transactionId: id, sequence: 1, submittedById: seller.userId, description: "synthetic completed delivery" } });
      await a.deliveryDecision.create({ data: { deliveryId: delivery.id, actorUserId: buyer.userId, decision: "ACCEPTED", reason: "synthetic integration fixture" } });
    }
    const escrow = await a.escrow.create({ data: { transactionId: id, currency: "INR", balanceMinor: 3000n, status: "FUNDED" } });
    if (type === "REFUND") await a.dispute.create({ data: { transactionId: id, openedById: buyer.userId, resolvedById: actor.userId, status: "RESOLVED", category: "test", description: "synthetic integration fixture", resolution } });
    return { transactionId: id, auth: actor, escrowId: escrow.id, buyerId: buyer.userId, sellerId: seller.userId };
  };
  const releaseAuth = await makeTOTPUser("USER");
  const releaseFixture = await makeRequestFixture({ status: "DELIVERED", type: "RELEASE", actor: releaseAuth });
  const releaseCalls = await Promise.all([a, b].map((client) => createEscrowService({ getClient: async () => client }).authorizeRelease({ auth: releaseFixture.auth, transactionId: releaseFixture.transactionId, idempotencyKey: "same-release-key-0001", reasonCode: "BUYER_ACCEPTED_DELIVERY" })));
  assert.equal(releaseCalls.filter((r) => !r.duplicate).length, 1);
  assert.equal(await a.escrowOperation.count({ where: { transactionId: releaseFixture.transactionId, type: "RELEASE" } }), 1);
  assert.equal((await a.transaction.findUnique({ where: { id: releaseFixture.transactionId } })).status, "RELEASE_PENDING");
  let providerCalls = 0; let signalStarted; let resolveProvider;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const providerResult = new Promise((resolve) => { resolveProvider = resolve; });
  const operationId = releaseCalls.find((result) => !result.duplicate).operationId;
  const executor = async ({ persistProviderReference }) => { providerCalls += 1; await persistProviderReference({ provider: "razorpay", providerReference: "trf_mock_1" }); signalStarted(); return providerResult; };
  const firstExecution = createEscrowService({ getClient: async () => a, releaseExecutor: executor }).executeAuthorizedOperation({ operationId });
  await started;
  const concurrentExecution = await createEscrowService({ getClient: async () => b, releaseExecutor: executor }).executeAuthorizedOperation({ operationId });
  assert.equal(concurrentExecution.inProgress, true);
  resolveProvider({ verified: false, outcome: "UNKNOWN" });
  assert.deepEqual(await firstExecution, { status: "PENDING", reconciliationRequired: true });
  assert.equal(providerCalls, 1, "lease must prevent duplicate provider execution");

  const refundAdmin = await makeTOTPUser("ADMIN");
  const refundFixture = await makeRequestFixture({ status: "DISPUTED", type: "REFUND", actor: refundAdmin, resolution: "REFUND" });
  const refundCalls = await Promise.all([a, b].map((client) => createEscrowService({ getClient: async () => client }).authorizeRefund({ auth: refundFixture.auth, transactionId: refundFixture.transactionId, idempotencyKey: "same-refund-key-0001", reasonCode: "ADMIN_RESOLVED_REFUND" })));
  assert.equal(refundCalls.filter((r) => !r.duplicate).length, 1);
  assert.equal(await a.escrowOperation.count({ where: { transactionId: refundFixture.transactionId, type: "REFUND" } }), 1);
  assert.equal((await a.transaction.findUnique({ where: { id: refundFixture.transactionId } })).status, "REFUND_PENDING");

  // Two independent workers compete for the same authorized outbox event.
  // The loser cannot reach the executor; verified completion commits one journal.
  await a.escrowOperation.update({ where: { id: operationId }, data: { nextAttemptAt: new Date(0) } });
  await a.outboxEvent.update({ where: { eventKey: `ESCROW_OPERATION:${operationId}` }, data: { status: "PENDING", nextAttemptAt: new Date(0), leaseOwner: null, leaseExpiresAt: null } });
  const refundOperationForFixture = await a.escrowOperation.findFirst({ where: { transactionId: refundFixture.transactionId, type: "REFUND" } });
  await a.outboxEvent.update({ where: { eventKey: `ESCROW_OPERATION:${refundOperationForFixture.id}` }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  let reconcileCalls = 0; let beginReconcile; let finishReconcile;
  const reconcileStarted = new Promise((resolve) => { beginReconcile = resolve; });
  const reconcileOutcome = new Promise((resolve) => { finishReconcile = resolve; });
  const releaseReconcileExecutor = async ({ providerReference }) => {
    reconcileCalls += 1; assert.equal(providerReference, "trf_mock_1"); beginReconcile(); return reconcileOutcome;
  };
  const workerA = createEscrowService({ getClient: async () => a, releaseExecutor: releaseReconcileExecutor }).processOutboxBatch({ limit: 1 });
  await reconcileStarted;
  const eligibleEvents = await b.outboxEvent.findMany({ where: { eventType: { in: ["ESCROW_RELEASE_AUTHORIZED", "ESCROW_REFUND_AUTHORIZED"] }, OR: [
    { status: "PENDING", nextAttemptAt: { lte: new Date() } }, { status: "PROCESSING", leaseExpiresAt: { lte: new Date() } },
  ] }, select: { eventKey: true } });
  assert.deepEqual(eligibleEvents, [], "after worker A claims its own operation, no unrelated eligible outbox events may remain for worker B");
  const workerB = await createEscrowService({ getClient: async () => b, releaseExecutor: releaseReconcileExecutor }).processOutboxBatch({ limit: 1 });
  assert.deepEqual(workerB, { claimed: 0, processed: 0, deferred: 0 });
  finishReconcile({ verified: true, outcome: "SUCCEEDED", provider: "razorpay", providerReference: "trf_mock_1", amountMinor: "3000", currency: "INR" });
  assert.deepEqual(await workerA, { claimed: 1, processed: 1, deferred: 0 });
  assert.equal(reconcileCalls, 1);
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: releaseFixture.transactionId } }), 1);
  assert.equal((await a.escrowOperation.findUnique({ where: { id: operationId } })).status, "SUCCEEDED");
  assert.equal((await a.transaction.findUnique({ where: { id: releaseFixture.transactionId } })).status, "COMPLETED");
  assert.equal((await a.outboxEvent.findUnique({ where: { eventKey: `ESCROW_OPERATION:${operationId}` } })).status, "PUBLISHED");
  preserveFinancialTransactions.add(releaseFixture.transactionId);
  preserveFinancialUsers.add(releaseFixture.auth.userId); preserveFinancialUsers.add(releaseFixture.sellerId);

  // Failure after journal insertion rolls back the journal, state, and operation update.
  const refundOperation = await a.escrowOperation.findFirst({ where: { transactionId: refundFixture.transactionId, type: "REFUND" } });
  await a.transaction.update({ where: { id: refundFixture.transactionId }, data: { status: "DISPUTED" } });
  const failingExecutor = createEscrowService({ getClient: async () => a, refundExecutor: async () => ({ verified: true, outcome: "SUCCEEDED", provider: "mock", providerReference: "refund_mock", amountMinor: "3000", currency: "INR" }) });
  await assert.rejects(failingExecutor.executeAuthorizedOperation({ operationId: refundOperation.id }));
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: refundFixture.transactionId } }), 0);
  assert.equal((await a.escrowOperation.findUnique({ where: { id: refundOperation.id } })).status, "PENDING");
  await a.transaction.update({ where: { id: refundFixture.transactionId }, data: { status: "REFUND_PENDING" } });
  await a.escrowOperation.update({ where: { id: refundOperation.id }, data: { providerReference: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(0) } });
  await a.outboxEvent.update({ where: { eventKey: `ESCROW_OPERATION:${refundOperation.id}` }, data: { status: "PENDING", nextAttemptAt: new Date(0), leaseOwner: null, leaseExpiresAt: null } });

  let timeoutCall = 0;
  const ambiguousRefund = createEscrowService({ getClient: async () => a, refundExecutor: async ({ persistProviderReference }) => {
    timeoutCall += 1;
    if (timeoutCall === 1) {
      await persistProviderReference({ provider: "razorpay", providerReference: "rfnd_mock_1" });
      return { verified: false, outcome: "PENDING", provider: "razorpay", providerReference: "rfnd_mock_1" };
    }
    throw new Error("synthetic provider timeout");
  } });
  assert.deepEqual(await ambiguousRefund.processOutboxBatch({ limit: 1 }), { claimed: 1, processed: 0, deferred: 1 });
  assert.equal((await a.escrowOperation.findUnique({ where: { id: refundOperation.id } })).providerReference, "rfnd_mock_1");
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: refundFixture.transactionId } }), 0);
  await a.escrowOperation.update({ where: { id: refundOperation.id }, data: { nextAttemptAt: new Date(0) } });
  await a.outboxEvent.update({ where: { eventKey: `ESCROW_OPERATION:${refundOperation.id}` }, data: { status: "PENDING", nextAttemptAt: new Date(0), leaseOwner: null, leaseExpiresAt: null } });

  let reconciliationCalls = 0; let signalReconciliation; let finishReconciliation;
  const reconciliationStarted = new Promise((resolve) => { signalReconciliation = resolve; });
  const reconciliationResult = new Promise((resolve) => { finishReconciliation = resolve; });
  const reconcileExecutor = async ({ providerReference }) => {
    reconciliationCalls += 1; assert.equal(providerReference, "rfnd_mock_1"); signalReconciliation(); return reconciliationResult;
  };
  const reconcileA = createEscrowService({ getClient: async () => a, refundExecutor: reconcileExecutor }).reconcilePendingOperations({ limit: 1 });
  await reconciliationStarted;
  const reconcileB = await createEscrowService({ getClient: async () => b, refundExecutor: reconcileExecutor }).reconcilePendingOperations({ limit: 1 });
  assert.deepEqual(reconcileB, { checked: 0, results: [] });
  finishReconciliation({ verified: true, outcome: "SUCCEEDED", provider: "razorpay", providerReference: "rfnd_mock_1", amountMinor: "3000", currency: "INR" });
  const reconciled = await reconcileA;
  assert.equal(reconciled.results[0].status, "SUCCEEDED");
  assert.equal(reconciliationCalls, 1);
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: refundFixture.transactionId } }), 1);
  assert.equal((await a.escrow.findUnique({ where: { transactionId_currency: { transactionId: refundFixture.transactionId, currency: "INR" } } })).balanceMinor, 0n);
  assert.equal((await a.transaction.findUnique({ where: { id: refundFixture.transactionId } })).status, "REFUNDED");
  const replay = await createEscrowService({ getClient: async () => a, refundExecutor: async () => { throw new Error("must not execute terminal operation"); } }).executeAuthorizedOperation({ operationId: refundOperation.id });
  assert.equal(replay.status, "SUCCEEDED");
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: refundFixture.transactionId } }), 1);
  await createEscrowService({ getClient: async () => a, refundExecutor: async () => {} }).processOutboxBatch({ limit: 1 });
  assert.equal((await a.outboxEvent.findUnique({ where: { eventKey: `ESCROW_OPERATION:${refundOperation.id}` } })).status, "PUBLISHED");
  preserveFinancialTransactions.add(refundFixture.transactionId);
  preserveFinancialUsers.add(refundFixture.auth.userId); preserveFinancialUsers.add(refundFixture.buyerId); preserveFinancialUsers.add(refundFixture.sellerId);

  // Posted ledger rows are immutable, so successful synthetic accounting fixtures remain in this isolated DB.
});
