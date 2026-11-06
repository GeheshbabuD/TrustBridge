import assert from "node:assert/strict";
import test from "node:test";
import { createTransactionDeliveryService } from "../../src/services/transaction-delivery.service.js";

const ids = { tx: "00000000-0000-4000-8000-000000000001", buyer: "00000000-0000-4000-8000-000000000002", seller: "00000000-0000-4000-8000-000000000003", delivery: "00000000-0000-4000-8000-000000000004" };
const setup = ({ status = "IN_PROGRESS", role = "SELLER", evidence = [], decision = null, required = [] } = {}) => {
  const transaction = { id: ids.tx, buyerId: ids.buyer, sellerId: ids.seller, status, version: 4, currency: "INR" };
  const delivery = { id: ids.delivery, transactionId: ids.tx, sequence: 1, submittedById: ids.seller, description: "Work delivered", evidence: evidence.map((id) => ({ id })), decision };
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => transaction, updateMany: async (args) => { writes.push(["transition", args]); transaction.status = args.data.status; transaction.version += 1; return { count: 1 }; } },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 2, role: "USER" }) },
    transactionParticipant: { findUnique: async () => ({ role }) },
    escrow: { findUnique: async () => ({ status: "FUNDED", balanceMinor: 100n }) },
    transactionDelivery: {
      findFirst: async () => null,
      create: async ({ data }) => { writes.push(["delivery", data]); return { ...delivery, ...data }; },
      findUnique: async () => delivery,
      findMany: async () => [delivery],
    },
    transactionTermsVersion: { findFirst: async () => ({ details: { evidenceRequirements: required } }) },
    deliveryDecision: { create: async ({ data }) => { writes.push(["decision", data]); return data; } },
    evidence: { create: async ({ data }) => ({ id: "00000000-0000-4000-8000-000000000005", ...data }) },
    transactionStatusHistory: { create: async ({ data }) => writes.push(["history", data]) },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => writes.push(["audit", data]) },
  };
  const client = { $transaction: (callback) => callback(tx), ...tx };
  return { transaction, delivery, writes, service: createTransactionDeliveryService({ getClient: async () => client }) };
};

test("seller starts work only after persisted funded escrow and records versioned history", async () => {
  const { service, writes } = setup({ status: "FUNDED", role: "SELLER" });
  const result = await service.startWork({ auth: { userId: ids.seller, authVersion: 2 }, transactionId: ids.tx, expectedVersion: 4 });
  assert.equal(result.status, "IN_PROGRESS");
  assert.equal(writes.filter(([kind]) => kind === "history").length, 1);
});

test("seller delivery submission moves transaction atomically and preserves audit metadata", async () => {
  const { service, writes } = setup();
  const result = await service.submitDelivery({ auth: { userId: ids.seller, authVersion: 2 }, transactionId: ids.tx, expectedVersion: 4, description: "Work delivered" });
  assert.equal(result.sequence, 1);
  assert.equal(writes.find(([kind]) => kind === "transition")[1].data.status, "DELIVERED");
  assert.ok(writes.some(([kind]) => kind === "history"));
  assert.ok(writes.some(([kind]) => kind === "audit"));
});

test("buyer acceptance requires agreed evidence and decisions are single-use", async () => {
  const noEvidence = setup({ status: "DELIVERED", role: "BUYER", required: ["receipt"] });
  await assert.rejects(noEvidence.service.decideDelivery({ auth: { userId: ids.buyer, authVersion: 2 }, transactionId: ids.tx, deliveryId: ids.delivery, expectedVersion: 4, decision: "ACCEPTED" }), (error) => error.code === "DELIVERY_EVIDENCE_REQUIRED");
  const withEvidence = setup({ status: "DELIVERED", role: "BUYER", evidence: ["evidence-id"], required: ["receipt"] });
  const result = await withEvidence.service.decideDelivery({ auth: { userId: ids.buyer, authVersion: 2 }, transactionId: ids.tx, deliveryId: ids.delivery, expectedVersion: 4, decision: "ACCEPTED" });
  assert.equal(result.decision, "ACCEPTED");
  assert.equal(withEvidence.writes.filter(([kind]) => kind === "transition").length, 0);
});

test("ADMIN and non-participants cannot start work or decide delivery", async () => {
  const admin = setup({ status: "FUNDED", role: null });
  await assert.rejects(admin.service.startWork({ auth: { userId: ids.seller, authVersion: 2, role: "ADMIN" }, transactionId: ids.tx, expectedVersion: 4 }));
  const wrongVersion = setup({ status: "FUNDED", role: "SELLER" });
  await assert.rejects(wrongVersion.service.startWork({ auth: { userId: ids.seller, authVersion: 1 }, transactionId: ids.tx, expectedVersion: 4 }));
});
