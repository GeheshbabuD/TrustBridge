import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";

const enabled = process.env.TRUSTBRIDGE_RECONCILIATION_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_tb050_clean";
assert.equal(testDatabase, "trustbridge_tb050_clean", "reconciliation persistence tests require the dedicated trustbridge_tb050_clean database");

test("reconciliation persistence enforces idempotency, snapshot uniqueness, finding uniqueness and one conditional claim winner", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl());
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(baseline.hostname));
  assert.equal(baseline.port || "5432", "5432");
  assert.equal(baseline.pathname, "/Trustbridge");
  const target = new URL(baseline);
  target.pathname = "/" + testDatabase;

  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([
    import("../../generated/prisma/client.ts"),
    import("@prisma/adapter-pg"),
    import("pg"),
  ]);
  const catalog = new Client({ connectionString: target.toString() });
  await catalog.connect();
  try {
    const identity = (await catalog.query("SELECT current_database() AS database, current_setting('server_version') AS version, current_setting('port') AS port, inet_server_addr()::text AS server, inet_client_addr()::text AS client")).rows[0];
    const history = (await catalog.query("SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name")).rows;
    const dirs = (await readdir("./prisma/migrations", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const applied = history.filter((entry) => entry.finished_at && !entry.rolled_back_at).map((entry) => entry.migration_name).sort();
    const loopback = (ip) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(ip);
    assert.equal(identity.database, testDatabase);
    assert.match(identity.version, /^17\./);
    assert.equal(identity.port, "5432");
    assert.ok(loopback(identity.server));
    assert.ok(loopback(identity.client));
    assert.equal(history.filter((entry) => !entry.finished_at && !entry.rolled_back_at).length, 0);
    assert.deepEqual(applied, dirs, "all repository migrations must be applied before persistence tests run");
  } finally {
    await catalog.end();
  }

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString() }) });
  const [a, b] = [makeClient(), makeClient()];
  const buyerId = randomUUID();
  const sellerId = randomUUID();
  const transactionId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const findingId = randomUUID();
  const suffix = randomUUID();

  t.after(async () => {
    await a.ledgerReconciliationFinding.deleteMany({ where: { id: findingId } });
    await a.ledgerReconciliationRunItem.deleteMany({ where: { id: itemId } });
    await a.ledgerReconciliationRun.deleteMany({ where: { id: runId } });
    await a.transaction.deleteMany({ where: { id: transactionId } });
    await a.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  await a.user.createMany({ data: [
    { id: buyerId, email: buyerId + "@tb052b-test.invalid", passwordHash: "test-only-placeholder-hash", role: "USER", status: "ACTIVE" },
    { id: sellerId, email: sellerId + "@tb052b-test.invalid", passwordHash: "test-only-placeholder-hash", role: "USER", status: "ACTIVE" },
  ] });
  await a.transaction.create({ data: {
    id: transactionId,
    buyerId,
    sellerId,
    createdById: buyerId,
    status: "FUNDED",
    amountMinor: 1000n,
    currency: "INR",
    terms: { test: true },
  } });

  const beforeFinancialRows = {
    payments: await a.paymentAttempt.count({ where: { transactionId } }),
    escrows: await a.escrow.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    entries: await a.ledgerEntry.count({ where: { transactionId } }),
  };

  await a.ledgerReconciliationRun.create({ data: {
    id: runId,
    idempotencyKey: "tb052b:" + suffix,
    triggerType: "MANUAL",
    requestedById: buyerId,
    itemLimit: 10,
    pageSize: 2,
    candidateCount: 1,
  } });
  await assert.rejects(
    a.ledgerReconciliationRun.create({ data: {
      id: randomUUID(),
      idempotencyKey: "tb052b:" + suffix,
      triggerType: "MANUAL",
      itemLimit: 10,
      pageSize: 2,
    } }),
    (error) => error.code === "P2002",
  );

  await a.ledgerReconciliationRunItem.create({ data: {
    id: itemId, runId, transactionId, ordinal: 0,
  } });
  await assert.rejects(
    a.ledgerReconciliationRunItem.create({ data: {
      id: randomUUID(), runId, transactionId, ordinal: 1,
    } }),
    (error) => error.code === "P2002",
  );

  await a.ledgerReconciliationFinding.create({ data: {
    id: findingId,
    transactionId,
    discrepancyCode: "TEST_COUNT_MISMATCH",
    occurrenceCount: 1,
    expectedCount: 1,
    observedCount: 0,
    firstRunId: runId,
    lastRunId: runId,
  } });
  await assert.rejects(
    a.ledgerReconciliationFinding.create({ data: {
      id: randomUUID(), transactionId, discrepancyCode: "TEST_COUNT_MISMATCH",
    } }),
    (error) => error.code === "P2002",
  );

  const claimTime = new Date();
  const claim = (client, owner) => client.ledgerReconciliationRunItem.updateMany({
    where: {
      id: itemId,
      status: "PENDING",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: claimTime } }],
    },
    data: { status: "PROCESSING", leaseOwner: owner, claimedAt: claimTime, leaseExpiresAt: new Date(claimTime.getTime() + 30_000), attemptCount: { increment: 1 } },
  });
  const results = await Promise.all([claim(a, "worker-a"), claim(b, "worker-b")]);
  assert.deepEqual(results.map((result) => result.count).sort(), [0, 1]);
  const savedItem = await a.ledgerReconciliationRunItem.findUnique({ where: { id: itemId } });
  assert.equal(savedItem.status, "PROCESSING");
  assert.ok(["worker-a", "worker-b"].includes(savedItem.leaseOwner));
  assert.equal(savedItem.attemptCount, 1);

  assert.deepEqual({
    payments: await a.paymentAttempt.count({ where: { transactionId } }),
    escrows: await a.escrow.count({ where: { transactionId } }),
    operations: await a.escrowOperation.count({ where: { transactionId } }),
    journals: await a.ledgerJournal.count({ where: { transactionId } }),
    entries: await a.ledgerEntry.count({ where: { transactionId } }),
  }, beforeFinancialRows);
});
