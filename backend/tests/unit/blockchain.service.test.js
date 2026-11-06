import test from "node:test";
import assert from "node:assert/strict";
import { enqueueBlockchainStatusCommitment } from "../../src/services/blockchain-event-hash.service.js";
import { createBlockchainService } from "../../src/services/blockchain.service.js";
import { createBlockchainOutboxWorker } from "../../src/workers/blockchain-outbox.worker.js";

test("status commitments are transactional, idempotent and contain no actor, reason or PII payload", async () => {
  const calls = [];
  const tx = {
    blockchainRecord: { upsert: async (args) => { calls.push(["record", args]); return { id: "record-1" }; } },
    outboxEvent: { upsert: async (args) => calls.push(["outbox", args]) },
  };
  const config = { enabled: true, chainId: 1337, contractAddress: "0x1234567890abcdef1234567890abcdef12345678" };
  await enqueueBlockchainStatusCommitment(tx, { transactionId: "tx-1", version: 2, previousStatus: "CREATED", newStatus: "ACCEPTED" }, config);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].create.eventHash.length, 64);
  assert.equal(calls[0][1].create.status, undefined, "Prisma default owns pending status");
  assert.deepEqual(calls[1][1].create.payload, { blockchainRecordId: "record-1" });
  assert.equal(JSON.stringify(calls).includes("SELLER_DECLINED"), false);
  assert.equal(JSON.stringify(calls).includes("private"), false);
  assert.equal(await enqueueBlockchainStatusCommitment(tx, { transactionId: "tx-1", version: 2, previousStatus: "CREATED", newStatus: "ACCEPTED" }, { enabled: false }), null);
});

test("leased worker persists only verified commitments and reconciles matching finalized records", async () => {
  const record = { id: "record-1", transactionId: "tx-1", network: "1337", contractReference: "contract", idempotencyKey: "txstatus:tx-1:1", eventHash: "22".repeat(32), status: "PENDING", transactionHash: null, blockNumber: null, blockHash: null, submittedAt: null };
  const event = { id: "outbox-1", payload: { blockchainRecordId: record.id }, attemptCount: 1 };
  const state = { outbox: "PENDING", record: { ...record } };
  const prisma = {
    outboxEvent: {
      findMany: async () => [{ id: event.id }],
      updateMany: async ({ where, data }) => { if (data.status === "PROCESSING" && state.outbox === "PENDING") { state.outbox = "PROCESSING"; state.owner = data.leaseOwner; return { count: 1 }; } if (where.leaseOwner === state.owner && state.outbox === "PROCESSING" && data.status) { state.outbox = data.status; return { count: 1 }; } return { count: 0 }; },
      findUnique: async () => event,
    },
    blockchainRecord: {
      findUnique: async () => state.record,
      update: async ({ data }) => { state.record = { ...state.record, ...data }; return state.record; },
      findMany: async () => [state.record],
      updateMany: async ({ data }) => { state.record = { ...state.record, ...data }; return { count: 1 }; },
    },
    $transaction: async (fn) => fn(prisma),
  };
  const adapter = {
    submitAnchor: async () => ({ status: "SUBMITTED", transactionHash: `0x${"ab".repeat(32)}`, blockNumber: null, blockHash: null }),
    reconcile: async (input) => ({ status: "CONFIRMED", transactionHash: input.transactionHash, blockNumber: 5n, blockHash: `0x${"cd".repeat(32)}` }),
  };
  const service = createBlockchainService({ getClient: async () => prisma, adapter, enabled: true, network: "1337", contractReference: "contract" });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, published: 1, deferred: 0 });
  assert.equal(state.outbox, "PUBLISHED");
  assert.equal(state.record.status, "SUBMITTED");
  assert.deepEqual(await service.reconcilePending(), { checked: 1, confirmed: 1, failed: 0, pending: 0 });
  assert.equal(state.record.status, "CONFIRMED");
  const worker = createBlockchainOutboxWorker({ blockchainService: service, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
  const result = await worker.runOnce();
  assert.equal(result.processing.claimed, 0);
  await worker.stop();
});

test("ambiguous adapter failures stay pending with sanitized retry state", async () => {
  const record = { id: "record-1", network: "1337", contractReference: "contract", idempotencyKey: "key", eventHash: "11".repeat(32), status: "PENDING" };
  const event = { id: "outbox-1", payload: { blockchainRecordId: record.id }, attemptCount: 1 };
  const updates = [];
  const prisma = {
    outboxEvent: { findMany: async () => [{ id: event.id }], updateMany: async ({ data }) => { updates.push(data); return { count: 1 }; }, findUnique: async () => event },
    blockchainRecord: { findUnique: async () => record, updateMany: async ({ data }) => updates.push(data) },
    $transaction: async (fn) => fn(prisma),
  };
  const service = createBlockchainService({ getClient: async () => prisma, adapter: { submitAnchor: async () => { throw new Error("provider body with secret"); }, reconcile: async () => ({ status: "PENDING" }) }, enabled: true, network: "1337", contractReference: "contract" });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, published: 0, deferred: 1 });
  assert.equal(JSON.stringify(updates).includes("secret"), false);
  assert.equal(updates.some((update) => update.lastErrorCode === "BLOCKCHAIN_PROVIDER_UNAVAILABLE"), true);
});

test("reconciliation reopens a confirmed record after a possible reorg and requeues the idempotent commitment", async () => {
  const record = { id: "record-reorg", status: "CONFIRMED", network: "1337", contractReference: "contract", idempotencyKey: "key", eventHash: "11".repeat(32), transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 10n, blockHash: `0x${"bb".repeat(32)}` };
  const changes = [];
  const prisma = {
    blockchainRecord: { findMany: async () => [record], updateMany: async ({ data }) => { changes.push(["record", data]); return { count: 1 }; } },
    outboxEvent: { updateMany: async ({ data }) => { changes.push(["outbox", data]); return { count: 1 }; } },
    $transaction: async (fn) => fn(prisma),
  };
  const service = createBlockchainService({ getClient: async () => prisma, adapter: { submitAnchor: async () => ({}), reconcile: async () => ({ status: "SUBMITTED", transactionHash: record.transactionHash }) }, enabled: true, network: "1337", contractReference: "contract" });
  assert.deepEqual(await service.reconcilePending(), { checked: 1, confirmed: 0, failed: 0, pending: 1 });
  assert.equal(changes[0][0], "record");
  assert.equal(changes[0][1].status, "SUBMITTED");
  assert.equal(changes[0][1].blockHash, null);
  assert.equal(changes[1][0], "outbox");
  assert.equal(changes[1][1].status, "PENDING");
});
