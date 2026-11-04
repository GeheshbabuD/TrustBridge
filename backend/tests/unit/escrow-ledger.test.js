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
    auditLog: { create: async ({ data }) => writes.push(["audit", data]) },
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
