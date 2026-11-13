import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createEscrowService } from "../../src/services/escrow.service.js";

const enabled = process.env.TRUSTBRIDGE_LEDGER_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_test";
assert.ok(["trustbridge_test", "trustbridge_tb050_clean"].includes(testDatabase), "only approved isolated PostgreSQL test databases are allowed");

test("read-only reconciliation sees a consistent snapshot during a concurrent financial posting rollback", { skip: !enabled }, async (t) => {
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
    const dirs = (await fs.readdir("./prisma/migrations", { withFileTypes: true })).filter((row) => row.isDirectory()).map((row) => row.name).sort();
    const row = identity.rows[0];
    const loopback = (ip) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(ip);
    assert.equal(row.database, testDatabase);
    assert.match(row.version, /^17\./);
    assert.equal(row.port, "5432");
    assert.ok(loopback(row.server_address)); assert.ok(loopback(row.client_address));
    assert.equal(history.rows.filter((entry) => !entry.finished_at && !entry.rolled_back_at).length, 0);
    const applied = history.rows.filter((entry) => entry.finished_at && !entry.rolled_back_at).map((entry) => entry.migration_name).sort();
    assert.deepEqual(applied, dirs);
  } finally { await catalog.end(); }

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const [a, b] = [makeClient(), makeClient()];
  const buyerId = randomUUID(); const sellerId = randomUUID(); const transactionId = randomUUID(); const paymentAttemptId = randomUUID();
  let writer;
  let retainPostedFixture = false;
  t.after(async () => {
    allowRollback?.();
    if (writer) await writer.catch(() => {});
    if (!retainPostedFixture) {
      await a.paymentAttempt.deleteMany({ where: { id: paymentAttemptId } });
      await a.transactionParticipant.deleteMany({ where: { transactionId } });
      await a.transaction.deleteMany({ where: { id: transactionId } });
      await a.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
    }
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });
  for (const id of [buyerId, sellerId]) await a.user.create({ data: { id, email: `${id}@tb051-ledger.invalid`, passwordHash: "test-only-placeholder-hash", role: "USER", status: "ACTIVE" } });
  await a.transaction.create({ data: { id: transactionId, buyerId, sellerId, createdById: buyerId, status: "AWAITING_PAYMENT", amountMinor: 8800n, currency: "INR", terms: { test: true }, participants: { create: [{ userId: buyerId, role: "BUYER" }, { userId: sellerId, role: "SELLER" }] } } });
  await a.paymentAttempt.create({ data: { id: paymentAttemptId, transactionId, provider: "test-mock", providerReference: `ref-${paymentAttemptId}`, capturedPaymentId: `pay_${paymentAttemptId.slice(0, 10)}`, idempotencyKey: `id-${paymentAttemptId}`, status: "CAPTURED", amountMinor: 8800n, currency: "INR" } });

  let signalStaged; let allowRollback;
  const staged = new Promise((resolve) => { signalStaged = resolve; });
  const rollbackGate = new Promise((resolve) => { allowRollback = resolve; });
  writer = b.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE`;
    const paymentAttempt = await tx.paymentAttempt.findUnique({ where: { id: paymentAttemptId } });
    await createEscrowService({ getClient: async () => b }).recordVerifiedFunding({ tx, paymentAttempt });
    signalStaged();
    await rollbackGate;
    throw new Error("intentional test rollback");
  });
  await staged;
  const beforeReadOnly = {
    escrow: await a.escrow.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
  };
  const report = await createEscrowService({ getClient: async () => a }).reconcileLedger({ transactionId });
  assert.equal(report.status, "CONSISTENT");
  assert.equal(report.transactionStatus, "AWAITING_PAYMENT");
  assert.equal(report.escrowBalanceMinor, null);
  assert.equal(report.ledgerLiabilityBalanceMinor, "0");
  assert.deepEqual({
    escrow: await a.escrow.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
  }, beforeReadOnly);
  allowRollback();
  await assert.rejects(writer, /intentional test rollback/);
  assert.equal(await a.escrow.count({ where: { transactionId } }), 0);
  assert.equal(await a.ledgerJournal.count({ where: { transactionId } }), 0);
  assert.deepEqual(report, await createEscrowService({ getClient: async () => b }).reconcileLedger({ transactionId }));

  // A valid, balanced but duplicated journal and a successful operation with no
  // journal are legal fixture inserts; reconciliation must surface both without
  // changing any persisted financial record.
  await a.transaction.update({ where: { id: transactionId }, data: { status: "FUNDED" } });
  const escrow = await a.escrow.create({ data: { transactionId, currency: "INR", status: "FUNDED", balanceMinor: 3n } });
  const clearing = await a.ledgerAccount.create({ data: { transactionId, accountCode: "PROVIDER_CLEARING", accountType: "ASSET", currency: "INR" } });
  const liability = await a.ledgerAccount.create({ data: { transactionId, escrowId: escrow.id, accountCode: "ESCROW_LIABILITY", accountType: "LIABILITY", currency: "INR" } });
  const operationId = `TEST_FUNDING:${transactionId}`;
  await a.$transaction(async (tx) => {
    const journal = await tx.ledgerJournal.create({ data: { transactionId, currency: "INR", operationId } });
    await tx.ledgerEntry.createMany({ data: [
      { journalId: journal.id, transactionId, currency: "INR", accountId: clearing.id, amountMinor: 1n, direction: "DEBIT" },
      { journalId: journal.id, transactionId, currency: "INR", accountId: clearing.id, amountMinor: 1n, direction: "DEBIT" },
      { journalId: journal.id, transactionId, currency: "INR", accountId: liability.id, amountMinor: 1n, direction: "CREDIT" },
      { journalId: journal.id, transactionId, currency: "INR", accountId: liability.id, amountMinor: 1n, direction: "CREDIT" },
    ] });
    await tx.escrowOperation.createMany({ data: [
      { transactionId, escrowId: escrow.id, ledgerJournalId: journal.id, type: "FUNDING", status: "SUCCEEDED", idempotencyKey: operationId, operationKey: operationId, amountMinor: 2n, currency: "INR", reasonCode: "TEST_DUPLICATE_LINES", completedAt: new Date() },
      { transactionId, escrowId: escrow.id, type: "REFUND", status: "SUCCEEDED", idempotencyKey: `TEST_MISSING_JOURNAL:${transactionId}`, operationKey: `TEST_MISSING_JOURNAL:${transactionId}`, amountMinor: 1n, currency: "INR", reasonCode: "TEST_MISSING_JOURNAL", completedAt: new Date() },
    ] });
  });
  const countsBefore = {
    balanceMinor: (await a.escrow.findUnique({ where: { transactionId_currency: { transactionId, currency: "INR" } } })).balanceMinor,
    escrow: await a.escrow.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    entries: await a.ledgerEntry.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
  };
  const anomaly = await createEscrowService({ getClient: async () => b }).reconcileLedger({ transactionId });
  const anomalyCodes = anomaly.discrepancies.map(({ code }) => code);
  assert.equal(anomaly.status, "DISCREPANCY");
  assert.ok(anomalyCodes.includes("DUPLICATE_JOURNAL_ENTRY"));
  assert.ok(anomalyCodes.includes("SUCCEEDED_OPERATION_MISSING_JOURNAL"));
  assert.ok(anomalyCodes.includes("ESCROW_LEDGER_BALANCE_MISMATCH"));
  assert.deepEqual({
    balanceMinor: (await a.escrow.findUnique({ where: { transactionId_currency: { transactionId, currency: "INR" } } })).balanceMinor,
    escrow: await a.escrow.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    entries: await a.ledgerEntry.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
  }, countsBefore);
  retainPostedFixture = true;
});
