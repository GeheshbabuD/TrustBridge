import assert from "node:assert/strict";
import test from "node:test";
import { createTransactionService } from "../../src/services/transaction.service.js";

const buyerId = "11111111-1111-4111-8111-111111111111";
const sellerId = "22222222-2222-4222-8222-222222222222";
const transactionId = "33333333-3333-4333-8333-333333333333";
const auth = { userId: buyerId, status: "ACTIVE", role: "USER", authVersion: 0 };
const base = { id: transactionId, buyerId, sellerId, status: "CREATED", amountMinor: 1200n, currency: "INR", terms: { description: "Work" }, version: 1, createdAt: new Date(), updatedAt: new Date(), participants: [{ userId: buyerId, role: "BUYER", joinedAt: new Date() }, { userId: sellerId, role: "SELLER", joinedAt: new Date() }] };

test("creation writes transaction, both participants, initial history, audit and idempotency atomically", async () => {
  const calls = [];
  const tx = {
    $queryRaw: async (_strings, ...values) => { calls.push(["lock", values[0]]); return []; },
    user: { findUnique: async ({ where }) => ({ id: where.id, status: "ACTIVE", role: "USER" }) },
    idempotencyOperation: { create: async ({ data }) => calls.push(["idempotency", data]), update: async ({ data }) => calls.push(["idempotency.complete", data]) },
    transaction: {
      create: async ({ data }) => { calls.push(["transaction", data]); return base; },
      findUnique: async () => base,
    },
    transactionParticipant: { createMany: async ({ data }) => calls.push(["participants", data]) },
    transactionTermsVersion: { create: async ({ data }) => calls.push(["terms.version", data]) },
    transactionStatusHistory: { create: async ({ data }) => calls.push(["history", data]) },
    auditLog: { create: async ({ data }) => calls.push(["audit", data]) },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }), fingerprintSecret: "unit-fingerprint-secret" });
  const result = await service.create({ auth, input: { sellerId, amountMinor: "1200", currency: "INR", terms: { description: "Work" } }, idempotencyKey: "idempotency-key-1", requestId: "req-1" });
  assert.equal(result.amountMinor, "1200");
  assert.equal("paymentAttempts" in result, false);
  assert.equal(calls.find(([name]) => name === "transaction")[1].createdById, buyerId);
  assert.equal(calls.find(([name]) => name === "participants")[1].length, 2);
  assert.equal(calls.find(([name]) => name === "history")[1].newStatus, "CREATED");
  assert.equal(calls.find(([name]) => name === "audit")[1].action, "TRANSACTION_CREATED");
});

test("only the persisted seller may accept and accepted transitions atomically append history and audit", async () => {
  const events = [];
  const state = { ...base };
  const tx = {
    $queryRaw: async () => { events.push("transaction.lock"); return []; },
    transaction: {
      findUnique: async () => ({ ...state }),
      updateMany: async ({ where, data }) => {
        events.push("transaction.update");
        if (where.version !== state.version) return { count: 0 };
        state.status = data.status; state.version += data.version.increment; return { count: 1 };
      },
    },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
    transactionTermsVersion: {
      findFirst: async () => ({ id: "terms-1", version: 1, status: "ACCEPTED", decisions: [ { actorUserId: buyerId, decision: "ACCEPTED" }, { actorUserId: sellerId, decision: "ACCEPTED" } ] }),
      updateMany: async () => ({ count: 0 }),
    },
    transactionInvitation: { findFirst: async () => ({ id: "invite-1" }), updateMany: async () => ({ count: 0 }) },
    transactionParticipant: { findUnique: async ({ where }) => ({ role: where.transactionId_userId.userId === sellerId ? "SELLER" : "BUYER" }) },
    transactionStatusHistory: { create: async ({ data }) => events.push(["history", data]) },
    auditLog: { create: async ({ data }) => events.push(["audit", data]) },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
  await assert.rejects(service.transition({ auth, transactionId, status: "ACCEPTED", expectedVersion: 1 }), { code: "TRANSACTION_TRANSITION_NOT_ALLOWED" });
  const result = await service.transition({ auth: { ...auth, userId: sellerId }, transactionId, status: "ACCEPTED", expectedVersion: 1 });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.version, 2);
  assert.equal(events.find((event) => Array.isArray(event) && event[0] === "history")[1].reason, "SELLER_ACCEPTED");
  assert.equal(events.find((event) => Array.isArray(event) && event[0] === "audit")[1].metadata.newStatus, "ACCEPTED");
  await assert.rejects(service.transition({ auth: { ...auth, userId: sellerId }, transactionId, status: "ACCEPTED", expectedVersion: 1 }), { code: "TRANSACTION_TRANSITION_NOT_ALLOWED" });
});

test("transition requires active current user, participant membership and expected version", async () => {
  const state = { ...base };
  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => ({ ...state }), updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
    transactionParticipant: { findUnique: async () => ({ role: "SELLER" }) },
    transactionStatusHistory: { create: async () => assert.fail("history must not be created") },
    auditLog: { create: async () => assert.fail("audit must not be written") },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
  await assert.rejects(service.transition({ auth: { ...auth, userId: sellerId }, transactionId, status: "ACCEPTED", expectedVersion: 7 }), { code: "TRANSACTION_VERSION_CONFLICT" });
  tx.user.findUnique = async () => ({ status: "SUSPENDED", authVersion: 0 });
  await assert.rejects(service.transition({ auth: { ...auth, userId: sellerId }, transactionId, status: "ACCEPTED", expectedVersion: 1 }), { code: "RESOURCE_NOT_FOUND" });
});

test("awaiting-payment cancellation succeeds only when no payment attempt exists", async (t) => {
  for (const attemptStatus of ["CREATED", "PENDING", "CAPTURED", "FAILED", "CANCELLED"]) {
    await t.test(`an existing ${attemptStatus} attempt fails closed without verified provider outcome`, async () => {
      const state = { ...base, status: "AWAITING_PAYMENT", version: 3 };
      let updateCalls = 0;
      const tx = {
        $queryRaw: async () => [],
        transaction: { findUnique: async () => ({ ...state }), updateMany: async () => { updateCalls += 1; return { count: 1 }; } },
        user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
        transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
        paymentAttempt: { findMany: async ({ where }) => {
          assert.deepEqual(where, { transactionId });
          return [{ id: "attempt-1", status: attemptStatus, webhookEvents: [] }];
        } },
        transactionStatusHistory: { create: async () => assert.fail("denied cancellation must not write history") },
        auditLog: { create: async () => assert.fail("denied cancellation must not write audit") },
      };
      const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
      await assert.rejects(service.transition({ auth, transactionId, status: "CANCELLED", expectedVersion: 3 }), { code: "PAYMENT_OUTCOME_UNVERIFIED" });
      assert.equal(updateCalls, 0);
    });
  }

  await t.test("no attempt permits buyer cancellation with atomic history and audit", async () => {
    const state = { ...base, status: "AWAITING_PAYMENT", version: 3 };
    const writes = [];
    const tx = {
      $queryRaw: async () => [],
      transaction: {
        findUnique: async () => ({ ...state }),
        updateMany: async ({ where, data }) => {
          assert.deepEqual(where, { id: transactionId, version: 3, status: "AWAITING_PAYMENT" });
          state.status = data.status; state.version += data.version.increment; return { count: 1 };
        },
      },
      user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
      transactionInvitation: { updateMany: async () => ({ count: 0 }) },
      transactionTermsVersion: { updateMany: async () => ({ count: 0 }) },
      transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
      paymentAttempt: { findMany: async () => [] },
      transactionStatusHistory: { create: async ({ data }) => writes.push(["history", data]) },
      auditLog: { create: async ({ data }) => writes.push(["audit", data]) },
    };
    const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
    const result = await service.transition({ auth, transactionId, status: "CANCELLED", expectedVersion: 3 });
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.version, 4);
    assert.equal(writes.length, 2);
    assert.equal(writes[0][1].reason, "BUYER_CANCELLED");
  });
});

test("payment, escrow, dispute and settlement transitions fail closed pending their authoritative workflows", async () => {
  const edges = [
    ["AWAITING_PAYMENT", "FUNDED"], ["FUNDED", "IN_PROGRESS"], ["FUNDED", "DISPUTED"],
    ["IN_PROGRESS", "DELIVERED"], ["IN_PROGRESS", "DISPUTED"], ["DELIVERED", "RELEASE_PENDING"],
    ["DELIVERED", "DISPUTED"], ["DISPUTED", "IN_PROGRESS"], ["DISPUTED", "RELEASE_PENDING"],
    ["DISPUTED", "REFUND_PENDING"], ["RELEASE_PENDING", "COMPLETED"], ["REFUND_PENDING", "REFUNDED"],
  ];
  for (const [currentStatus, status] of edges) {
    const tx = {
      $queryRaw: async () => [],
      transaction: { findUnique: async () => ({ ...base, status: currentStatus }), updateMany: async () => assert.fail("unsupported transition must not update") },
      user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
      transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
      transactionStatusHistory: { create: async () => assert.fail("unsupported transition must not append history") },
      auditLog: { create: async () => assert.fail("unsupported transition must not append audit") },
    };
    const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
    await assert.rejects(service.transition({ auth, transactionId, status, expectedVersion: 1 }), { code: "TRANSACTION_TRANSITION_NOT_ALLOWED" });
  }

  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => ({ ...base }), updateMany: async () => assert.fail("ADMIN must not bypass participant policy") },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
    transactionParticipant: { findUnique: async () => null },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
  await assert.rejects(service.transition({ auth: { ...auth, role: "ADMIN", userId: "55555555-5555-4555-8555-555555555555" }, transactionId, status: "ACCEPTED", expectedVersion: 1 }), { code: "RESOURCE_NOT_FOUND" });
});

test("awaiting-payment cancellation fails closed when payment-attempt storage is unavailable", async () => {
  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => ({ ...base, status: "AWAITING_PAYMENT", version: 3 }), updateMany: async () => assert.fail("storage failure must not update") },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
    transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
    paymentAttempt: { findMany: async () => { throw new Error("database unavailable"); } },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
  await assert.rejects(service.transition({ auth, transactionId, status: "CANCELLED", expectedVersion: 3 }), { code: "TRANSACTION_STORAGE_UNAVAILABLE" });
});

test("awaiting-payment cancellation accepts only a processed verified no-capture event", async () => {
  const state = { ...base, status: "AWAITING_PAYMENT", version: 3 };
  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => ({ ...state }), updateMany: async ({ data }) => { state.status = data.status; state.version += 1; return { count: 1 }; } },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 0 }) },
    transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
    paymentAttempt: { findMany: async () => [{ id: "attempt-1", status: "FAILED", webhookEvents: [{ status: "PROCESSED", eventData: { final: true, noCapture: true, outcome: "FAILED" } }] }] },
    transactionStatusHistory: { create: async () => {} },
    transactionInvitation: { updateMany: async () => ({ count: 0 }) },
    transactionTermsVersion: { updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => {} },
  };
  const service = createTransactionService({ getClient: async () => ({ $transaction: (fn) => fn(tx) }) });
  const result = await service.transition({ auth, transactionId, status: "CANCELLED", expectedVersion: 3 });
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.version, 4);
});
