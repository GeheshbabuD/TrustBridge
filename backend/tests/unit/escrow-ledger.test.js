import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEscrowService } from "../../src/services/escrow.service.js";

const migrationPath = new URL("../../prisma/migrations/20261104130000_escrow_ledger_operations/migration.sql", import.meta.url);
const leaseMigrationPath = new URL("../../prisma/migrations/20261104131000_escrow_execution_leases/migration.sql", import.meta.url);
const schemaPath = new URL("../../prisma/schema.prisma", import.meta.url);

const fundingFixture = () => {
  const calls = [];
  const transaction = { id: "tx-1", status: "AWAITING_PAYMENT", version: 3, amountMinor: 12500n, currency: "INR " };
  const escrow = { id: "esc-1", transactionId: "tx-1", currency: "INR ", status: "UNFUNDED", balanceMinor: 0n };
  const tx = {
    transaction: { findUnique: async () => transaction, updateMany: async (args) => { calls.push(["transaction.updateMany", args]); return { count: 1 }; } },
    escrow: { upsert: async () => escrow, update: async (_args) => calls.push(["escrow.update", _args]) },
    escrowOperation: { findUnique: async () => null, create: async ({ data }) => { calls.push(["operation", data]); return { id: "op-1" }; } },
    ledgerAccount: { upsert: async ({ create }) => ({ id: create.accountCode }) },
    ledgerJournal: { create: async ({ data }) => { calls.push(["journal", data]); return { id: "journal-1" }; } },
    ledgerEntry: { createMany: async ({ data }) => { calls.push(["entries", data]); return { count: data.length }; } },
    transactionStatusHistory: { create: async ({ data }) => calls.push(["history", data]) },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => calls.push(["audit", data]) },
  };
  return { tx, calls, transaction };
};

test("verified capture posts an integer-minor balanced journal and atomically advances internal escrow/transaction state", async () => {
  const { tx, calls, transaction } = fundingFixture();
  const service = createEscrowService({ now: () => new Date("2026-11-04T00:00:00Z") });
  const result = await service.recordVerifiedFunding({ tx, paymentAttempt: { id: "pay-1", transactionId: "tx-1", provider: "razorpay", providerReference: "order-1", status: "CAPTURED", amountMinor: 12500n, currency: "INR " } });
  assert.deepEqual(result, { funded: true, duplicate: false });
  const entries = calls.find(([name]) => name === "entries")[1];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].amountMinor, 12500n);
  assert.equal(entries[1].amountMinor, 12500n);
  assert.equal(entries[0].direction, "DEBIT");
  assert.equal(entries[1].direction, "CREDIT");
  assert.equal(entries[0].currency.trim(), "INR");
  assert.equal(calls.find(([name]) => name === "transaction.updateMany")[1].data.status, "FUNDED");
  assert.equal(transaction.status, "AWAITING_PAYMENT"); // fixture is not mutated by the persistence mock
});

test("funding rejects uncaptured or amount/currency-mismatched provider outcomes", async () => {
  const service = createEscrowService();
  const { tx } = fundingFixture();
  await assert.rejects(service.recordVerifiedFunding({ tx, paymentAttempt: { status: "PENDING", amountMinor: 12500n } }), { code: "CAPTURE_NOT_VERIFIED" });
  const mismatch = { ...fundingFixture(), tx: fundingFixture().tx };
  await assert.rejects(service.recordVerifiedFunding({ tx: mismatch.tx, paymentAttempt: { id: "pay-2", transactionId: "tx-1", status: "CAPTURED", amountMinor: 999n, currency: "INR " } }), { code: "PAYMENT_EVENT_MISMATCH" });
});

test("ambiguous provider execution remains pending and performs no ledger or status write", async () => {
  let transactionCalls = 0;
  const client = { escrowOperation: { findUnique: async () => ({ id: "op-1", transactionId: "tx-1", escrowId: "esc-1", type: "RELEASE", status: "PENDING", amountMinor: 12500n, currency: "INR", operationKey: "RELEASE:op-1", attemptCount: 0 }), updateMany: async () => ({ count: 1 }) }, $transaction: async () => { transactionCalls += 1; } };
  const service = createEscrowService({ getClient: async () => client, releaseExecutor: async () => ({ verified: false, outcome: "SUCCEEDED" }) });
  assert.deepEqual(await service.executeAuthorizedOperation({ operationId: "op-1" }), { status: "PENDING", reconciliationRequired: true });
  assert.equal(transactionCalls, 0);
});

test("verified mocked release posts the balancing journal and finalizes escrow only after provider evidence", async () => {
  const writes = [];
  const operation = { id: "op-2", transactionId: "tx-2", escrowId: "esc-2", type: "RELEASE", status: "PENDING", amountMinor: 9000n, currency: "INR", operationKey: "RELEASE:op-2" };
  const tx = {
    $queryRaw: async () => [],
    escrowOperation: { findUnique: async () => operation, updateMany: async ({ data }) => { writes.push(["operation", data]); return { count: 1 }; } },
    escrow: { findUnique: async () => ({ id: "esc-2", status: "RELEASE_PENDING", balanceMinor: 9000n }), update: async ({ data }) => writes.push(["escrow", data]) },
    ledgerAccount: { upsert: async ({ create }) => ({ id: create.accountCode }) },
    ledgerJournal: { create: async ({ data }) => { writes.push(["journal", data]); return { id: "journal-2" }; } },
    ledgerEntry: { createMany: async ({ data }) => writes.push(["entries", data]) },
    transaction: { findUnique: async () => ({ id: "tx-2", status: "RELEASE_PENDING", version: 4 }), updateMany: async ({ data }) => { writes.push(["transaction", data]); return { count: 1 }; } },
    transactionStatusHistory: { create: async ({ data }) => writes.push(["history", data]) },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => writes.push(["audit", data]) },
    dispute: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  };
  const client = { escrowOperation: { findUnique: async () => ({ ...operation, attemptCount: 0, transaction: { status: "RELEASE_PENDING" } }), updateMany: async () => ({ count: 1 }) }, $transaction: (callback) => callback(tx) };
  const service = createEscrowService({ getClient: async () => client, releaseExecutor: async () => ({ verified: true, outcome: "SUCCEEDED", provider: "mock", providerReference: "payout-ref", amountMinor: "9000", currency: "INR" }) });
  assert.deepEqual(await service.executeAuthorizedOperation({ operationId: "op-2" }), { status: "SUCCEEDED", ledgerJournalId: "journal-2" });
  assert.equal(writes.find(([key]) => key === "transaction")[1].status, "COMPLETED");
  assert.equal(writes.find(([key]) => key === "escrow")[1].balanceMinor, 0n);
  const entries = writes.find(([key]) => key === "entries")[1];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].amountMinor, entries[1].amountMinor);
  assert.equal(entries[0].direction, "DEBIT");
  assert.equal(entries[1].direction, "CREDIT");
});

test("verified partial refund posts only the adjudicated amount and retains funded escrow balance", async () => {
  const writes = [];
  const operation = { id: "op-partial", transactionId: "tx-partial", escrowId: "esc-partial", type: "REFUND", status: "PENDING", amountMinor: 2500n, currency: "INR", reasonCode: "ADMIN_RESOLVED_PARTIAL_REFUND", operationKey: "REFUND:op-partial" };
  const tx = {
    $queryRaw: async () => [],
    escrowOperation: { findUnique: async () => operation, updateMany: async ({ data }) => { writes.push(["operation", data]); return { count: 1 }; } },
    escrow: { findUnique: async () => ({ id: "esc-partial", status: "REFUND_PENDING", balanceMinor: 9000n }), update: async ({ data }) => writes.push(["escrow", data]) },
    ledgerAccount: { upsert: async ({ create }) => ({ id: create.accountCode }) },
    ledgerJournal: { create: async ({ data }) => { writes.push(["journal", data]); return { id: "journal-partial" }; } },
    ledgerEntry: { createMany: async ({ data }) => writes.push(["entries", data]) },
    transaction: { findUnique: async () => ({ id: "tx-partial", status: "REFUND_PENDING", version: 8 }), updateMany: async ({ data }) => { writes.push(["transaction", data]); return { count: 1 }; } },
    transactionStatusHistory: { create: async ({ data }) => writes.push(["history", data]) },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => writes.push(["audit", data]) },
  };
  const client = { escrowOperation: { findUnique: async () => ({ ...operation, attemptCount: 0, transaction: { status: "REFUND_PENDING" } }), updateMany: async () => ({ count: 1 }) }, $transaction: (callback) => callback(tx) };
  const service = createEscrowService({ getClient: async () => client, refundExecutor: async () => ({ verified: true, outcome: "SUCCEEDED", provider: "mock", providerReference: "refund-partial", amountMinor: "2500", currency: "INR" }) });
  assert.deepEqual(await service.executeAuthorizedOperation({ operationId: operation.id }), { status: "SUCCEEDED", ledgerJournalId: "journal-partial" });
  assert.equal(writes.find(([key]) => key === "entries")[1][0].amountMinor, 2500n);
  assert.equal(writes.find(([key]) => key === "escrow")[1].status, "FUNDED");
  assert.equal(writes.find(([key]) => key === "escrow")[1].balanceMinor, 6500n);
  assert.equal(writes.find(([key]) => key === "transaction")[1].status, "DELIVERED");
});

test("ledger migration is additive and declares immutable, deferred balanced-journal enforcement", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TYPE "EscrowOperationType"/);
  assert.match(sql, /CREATE TABLE "escrow_operations"/);
  assert.match(sql, /"amount_minor" BIGINT NOT NULL/);
  assert.match(sql, /CHECK \("amount_minor" > 0\)/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /ledger_journals_immutable/);
  assert.match(sql, /ledger_entries_immutable/);
  assert.match(sql, /COUNT\(\*\)/);
  assert.match(sql, /debit_total <> credit_total/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
});

test("EscrowOperation Prisma model uses BigInt, restrictive relations, idempotency and lookup indexes", async () => {
  const schema = await readFile(schemaPath, "utf8");
  const model = schema.match(/model EscrowOperation \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model);
  assert.match(model, /amountMinor\s+BigInt/);
  assert.match(model, /ProviderOperationStatus/);
  assert.match(model, /@@unique\(\[transactionId, idempotencyKey\]/);
  assert.match(model, /paymentAttemptId\s+String\?\s+@unique/);
  assert.match(model, /onDelete: Restrict/);
  assert.match(model, /@@index\(\[transactionId, type, status, createdAt\]/);
});

test("execution lease migration is additive and supports bounded retry claims", async () => {
  const sql = await readFile(leaseMigrationPath, "utf8");
  assert.match(sql, /ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN "next_attempt_at" TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN "lease_owner"/);
  assert.match(sql, /ADD COLUMN "lease_expires_at"/);
  assert.match(sql, /attempt_count_nonnegative_check/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
});

test("escrow outbox worker uses the operation lease and reschedules ambiguous provider outcomes with persisted reference", async () => {
  const outboxUpdates = []; const operationUpdates = []; let executorCalls = 0;
  const operation = { id: "11111111-1111-4111-8111-111111111111", transactionId: "22222222-2222-4222-8222-222222222222", escrowId: "esc-worker", type: "REFUND", status: "PENDING", amountMinor: 3000n, currency: "INR", operationKey: "REFUND:tx-worker:hash", attemptCount: 0, providerReference: null };
  const client = {
    outboxEvent: {
      findMany: async () => [{ id: "event-1", eventKey: `ESCROW_OPERATION:${operation.id}`, eventType: "ESCROW_REFUND_AUTHORIZED", aggregateType: "TRANSACTION", aggregateId: operation.transactionId, transactionId: operation.transactionId, payload: { operationId: operation.id, type: "REFUND", amountMinor: "3000", currency: "INR" } }],
      updateMany: async (args) => { outboxUpdates.push(args); return { count: 1 }; },
    },
    escrowOperation: {
      findUnique: async () => ({ ...operation, transaction: { status: "REFUND_PENDING" } }),
      updateMany: async (args) => { operationUpdates.push(args); Object.assign(operation, args.data); return { count: 1 }; },
    },
  };
  const service = createEscrowService({ getClient: async () => client, refundExecutor: async ({ persistProviderReference }) => {
    executorCalls += 1;
    await persistProviderReference({ provider: "razorpay", providerReference: "rfnd_1" });
    return { verified: false, outcome: "PENDING", provider: "razorpay", providerReference: "rfnd_1" };
  } });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, processed: 0, deferred: 1, failed: 0 });
  assert.equal(executorCalls, 2); // initial outcome followed by a reference-bound reconciliation
  assert.equal(operationUpdates.length, 6);
  assert.equal(operationUpdates[1].data.providerReference, "rfnd_1");
  assert.equal(operationUpdates[1].data.status, undefined);
  assert.equal(outboxUpdates.at(-1).data.status, "PENDING");
  assert.equal(outboxUpdates.at(-1).data.lastErrorCode, "PROVIDER_OUTCOME_PENDING");
});

test("structurally invalid escrow outbox events become retained terminal failures and cannot replay", async () => {
  const operation = { id: "11111111-1111-4111-8111-111111111111", transactionId: "22222222-2222-4222-8222-222222222222", type: "RELEASE", amountMinor: 5000n, currency: "INR" };
  const row = { id: "event-invalid", eventKey: `ESCROW_OPERATION:${operation.id}`, eventType: "ESCROW_RELEASE_AUTHORIZED", aggregateType: "TRANSACTION", aggregateId: operation.transactionId, transactionId: operation.transactionId, payload: { operationId: operation.id, type: "RELEASE", amountMinor: "5001", currency: "INR" }, status: "PENDING", leaseOwner: null };
  const updates = []; let executions = 0;
  const client = {
    outboxEvent: {
      findMany: async () => row.status === "FAILED" ? [] : [row],
      updateMany: async ({ where, data }) => {
        if (where.id !== row.id || (data.status === "PROCESSING" && !["PENDING", "PROCESSING"].includes(row.status)) || (where.leaseOwner && row.leaseOwner !== where.leaseOwner)) return { count: 0 };
        Object.assign(row, data); updates.push(data); return { count: 1 };
      },
    },
    escrowOperation: { findUnique: async () => operation, updateMany: async () => ({ count: 1 }) },
  };
  const service = createEscrowService({ getClient: async () => client, releaseExecutor: async () => { executions += 1; return { verified: false }; } });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, processed: 0, deferred: 0, failed: 1 });
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastErrorCode, "ESCROW_OUTBOX_INVALID_EVENT");
  assert.equal(row.leaseOwner, null);
  assert.equal(row.leaseExpiresAt, null);
  assert.equal(executions, 0);
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 0, processed: 0, deferred: 0, failed: 0 });
  assert.equal(executions, 0);
});

test("transient database failure keeps escrow outbox work pending on the existing retry schedule", async () => {
  const transactionId = "22222222-2222-4222-8222-222222222222";
  const row = { id: "event-transient", eventKey: "ESCROW_OPERATION:11111111-1111-4111-8111-111111111111", eventType: "ESCROW_RELEASE_AUTHORIZED", aggregateType: "TRANSACTION", aggregateId: transactionId, transactionId, payload: { operationId: "11111111-1111-4111-8111-111111111111", type: "RELEASE", amountMinor: "5000", currency: "INR" }, status: "PENDING" };
  const updates = []; let executions = 0;
  const client = {
    outboxEvent: { findMany: async () => [row], updateMany: async ({ data }) => { updates.push(data); Object.assign(row, data); return { count: 1 }; } },
    escrowOperation: { findUnique: async () => { throw new Error("database unavailable"); } },
  };
  const service = createEscrowService({ getClient: async () => client, now: () => new Date("2026-01-02T00:00:00.000Z"), releaseExecutor: async () => { executions += 1; } });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, processed: 0, deferred: 1, failed: 0 });
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "ESCROW_WORKER_RETRY");
  assert.equal(row.nextAttemptAt.toISOString(), "2026-01-02T00:01:00.000Z");
  assert.equal(row.leaseOwner, null);
  assert.equal(executions, 0);
});

test("expired escrow outbox leases are reclaimable once and competing claims defer without provider execution", async () => {
  const operation = { id: "11111111-1111-4111-8111-111111111111", transactionId: "22222222-2222-4222-8222-222222222222", type: "RELEASE", amountMinor: 5000n, currency: "INR", status: "PENDING", attemptCount: 0, providerReference: null };
  const now = () => new Date("2026-01-02T00:00:00.000Z");
  const row = { id: "event-expired", eventKey: `ESCROW_OPERATION:${operation.id}`, eventType: "ESCROW_RELEASE_AUTHORIZED", aggregateType: "TRANSACTION", aggregateId: operation.transactionId, transactionId: operation.transactionId, payload: { operationId: operation.id, type: "RELEASE", amountMinor: "5000", currency: "INR" }, status: "PROCESSING", leaseOwner: "expired-owner", leaseExpiresAt: new Date("2026-01-01T23:59:00.000Z"), nextAttemptAt: new Date("2026-01-01T23:59:00.000Z") };
  const claims = []; let providerCalls = 0;
  const makeClient = () => ({
    outboxEvent: {
      findMany: async () => [row],
      updateMany: async ({ where, data }) => {
        if (data.status === "PROCESSING") {
          const eligible = (row.status === "PENDING" && row.nextAttemptAt <= where.OR[0].status.nextAttemptAt.lte)
            || (row.status === "PROCESSING" && row.leaseExpiresAt <= where.OR[1].leaseExpiresAt.lte);
          if (!eligible) return { count: 0 };
          Object.assign(row, data); claims.push(data.leaseOwner); return { count: 1 };
        }
        if (row.status !== "PROCESSING" || row.leaseOwner !== where.leaseOwner) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    escrowOperation: { findUnique: async () => operation, updateMany: async () => ({ count: 0 }) },
  });
  const serviceA = createEscrowService({ getClient: async () => makeClient(), now, releaseExecutor: async () => { providerCalls += 1; } });
  const serviceB = createEscrowService({ getClient: async () => makeClient(), now, releaseExecutor: async () => { providerCalls += 1; } });
  const results = await Promise.all([serviceA.processOutboxBatch(), serviceB.processOutboxBatch()]);
  assert.equal(claims.length, 1);
  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.deferred, 0), 1);
  assert.equal(row.status, "PENDING");
  assert.equal(row.lastErrorCode, "PROVIDER_OUTCOME_PENDING");
  assert.equal(providerCalls, 0);
});

test("authoritative terminal provider failure restores the funded pre-operation state without posting a journal", async () => {
  const operation = { id: "op-failed", transactionId: "tx-failed", escrowId: "esc-failed", type: "RELEASE", status: "PENDING", amountMinor: 3000n, currency: "INR", operationKey: "RELEASE:tx-failed:key", attemptCount: 0, providerReference: null, leaseOwner: null };
  const writes = [];
  const conditionalUpdate = async ({ where, data }) => {
    if (where.id !== operation.id || operation.status !== "PENDING" || (where.leaseOwner && operation.leaseOwner !== where.leaseOwner)) return { count: 0 };
    Object.assign(operation, data); writes.push(data); return { count: 1 };
  };
  const tx = {
    $queryRaw: async () => [],
    escrowOperation: { findUnique: async () => operation, updateMany: conditionalUpdate },
    escrow: { findUnique: async () => ({ id: operation.escrowId, status: "RELEASE_PENDING", balanceMinor: 3000n }), update: async ({ data }) => writes.push({ escrow: data }) },
    transaction: { findUnique: async () => ({ id: operation.transactionId, status: "RELEASE_PENDING", version: 8 }), updateMany: async ({ data }) => { writes.push({ transaction: data }); return { count: 1 }; } },
    transactionStatusHistory: { create: async ({ data }) => writes.push({ history: data }) },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => writes.push({ audit: data }) },
  };
  const client = { escrowOperation: { findUnique: async () => ({ ...operation, transaction: {} }), updateMany: conditionalUpdate }, $transaction: async (callback) => callback(tx) };
  const service = createEscrowService({ getClient: async () => client, releaseExecutor: async () => ({ verified: true, outcome: "FAILED", final: true, provider: "razorpay", providerReference: "trf_failed", amountMinor: "3000", currency: "INR" }) });
  assert.deepEqual(await service.executeAuthorizedOperation({ operationId: operation.id }), { status: "FAILED", providerReference: "trf_failed" });
  assert.equal(operation.status, "FAILED");
  assert.equal(operation.providerReference, "trf_failed");
  assert.ok(writes.some((write) => write.escrow?.status === "FUNDED"));
  assert.ok(writes.some((write) => write.transaction?.status === "DELIVERED"));
  assert.equal(writes.some((write) => Object.hasOwn(write, "journalId")), false);
});
