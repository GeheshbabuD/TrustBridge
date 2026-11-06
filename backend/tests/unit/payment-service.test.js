import assert from "node:assert/strict";
import test from "node:test";
import { createPaymentService } from "../../src/services/payment.service.js";
import { createDeterministicPaymentTestAdapter } from "../support/payment-test-adapter.js";

const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const buyerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const termsVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const fixture = () => {
  const state = { attempt: null, idempotency: null, outbox: null, webhooks: [], audits: [], updates: [] };
  const tx = {
    $queryRaw: async () => [],
    transaction: { findUnique: async () => ({ id: transactionId, buyerId, status: "AWAITING_PAYMENT", amountMinor: 5500n, currency: "USD", version: 3 }) },
    user: { findUnique: async () => ({ status: "ACTIVE", authVersion: 4, role: "USER" }) },
    transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
    transactionTermsVersion: { findFirst: async () => ({ id: termsVersionId, status: "ACCEPTED", amountMinor: 5500n, currency: "USD", decisions: [{ actorUserId: buyerId, decision: "ACCEPTED" }, { actorUserId: "seller", decision: "ACCEPTED" }] }) },
    idempotencyOperation: {
      findUnique: async () => state.idempotency,
      create: async ({ data }) => { state.idempotency = { ...data }; },
      update: async ({ data }) => { state.idempotency = { ...state.idempotency, ...data }; },
    },
    paymentAttempt: {
      findFirst: async () => null,
      findUnique: async () => state.attempt,
      create: async ({ data }) => { state.attempt = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ...data, createdAt: new Date(), updatedAt: new Date(), providerReference: null }; return state.attempt; },
      updateMany: async ({ where, data }) => {
        state.updates.push({ where, data });
        if (!state.attempt || where.id !== state.attempt.id || (where.provider && where.provider !== state.attempt.provider) || where.status?.in?.includes(state.attempt.status) !== true || (state.attempt.providerReference && data.providerReference && state.attempt.providerReference !== data.providerReference)) return { count: 0 };
        state.attempt = { ...state.attempt, ...data };
        return { count: 1 };
      },
      update: async ({ data }) => { state.attempt = { ...state.attempt, ...data }; return state.attempt; },
    },
    outboxEvent: {
      create: async ({ data }) => { state.outbox = { id: "outbox", status: "PENDING", ...data }; },
      updateMany: async ({ data }) => { Object.assign(state.outbox, data); return { count: 1 }; },
    },
    webhookEvent: {
      create: async ({ data }) => { if (state.webhooks.some((event) => event.eventId === data.eventId)) { const error = new Error("duplicate"); error.code = "P2002"; throw error; } const event = { id: `event-${state.webhooks.length}`, ...data }; state.webhooks.push(event); return event; },
      update: async ({ where, data }) => { const index = state.webhooks.findIndex((event) => event.id === where.id); state.webhooks[index] = { ...state.webhooks[index], ...data }; return state.webhooks[index]; },
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return { id: "audit" }; } },
    $transaction: async (fn) => fn(tx),
  };
  const prisma = {
    ...tx,
    paymentAttempt: { ...tx.paymentAttempt, findFirst: async ({ where }) => where.providerReference ? state.attempt : null },
  };
  return { prisma, state };
};

const auth = { userId: buyerId, role: "USER", status: "ACTIVE", authVersion: 4 };

test("payment initiation reserves persisted terms, idempotency and outbox before adapter call", async () => {
  const { prisma, state } = fixture();
  let providerInput;
  const base = createDeterministicPaymentTestAdapter();
  const adapter = { ...base, async createPaymentIntent(input) { providerInput = input; return base.createPaymentIntent(input); } };
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true, now: () => new Date("2026-11-04T00:00:00Z") });
  const result = await service.initiate({ auth, transactionId, idempotencyKey: "payment-key-0001" });
  assert.equal(result.accepted, true);
  assert.equal(result.attempt.status, "PENDING");
  assert.equal(result.attempt.amountMinor, "5500");
  assert.equal(providerInput.amountMinor, "5500");
  assert.equal(state.attempt.providerReference, `test_${state.attempt.id}`);
  assert.equal(state.attempt.status, "PENDING");
  assert.equal(state.idempotency.status, "COMPLETED");
  assert.equal(state.outbox.status, "PUBLISHED");
  assert.equal(JSON.stringify(result).includes("providerReference"), false);
});

test("repeated identical idempotency key returns the existing attempt", async () => {
  const { prisma, state } = fixture();
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true, fingerprintSecret: "test-fingerprint-key" });
  const first = await service.initiate({ auth, transactionId, idempotencyKey: "payment-key-same" });
  const second = await service.initiate({ auth, transactionId, idempotencyKey: "payment-key-same" });
  assert.equal(first.attempt.id, second.attempt.id);
  assert.equal(second.idempotent, true);
  assert.equal(state.attempt.id, first.attempt.id);
});

test("provider timeout preserves a pending attempt and retryable outbox", async () => {
  const { prisma, state } = fixture();
  const base = createDeterministicPaymentTestAdapter();
  const adapter = { ...base, async createPaymentIntent() { throw new Error("provider timed out"); } };
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true, fingerprintSecret: "test-fingerprint-key" });
  const result = await service.initiate({ auth, transactionId, idempotencyKey: "payment-key-timeout" });
  assert.equal(result.attempt.status, "PENDING");
  assert.equal(state.attempt.failureCode, "PROVIDER_OUTCOME_UNKNOWN");
  assert.equal(state.attempt.providerReference, null);
  assert.equal(state.outbox.status, "PENDING");
});

test("payment adapter unavailability fails closed before creating an attempt", async () => {
  const { prisma, state } = fixture();
  const service = createPaymentService({ getClient: async () => prisma, enabled: true, provider: "unconfigured" });
  await assert.rejects(service.initiate({ auth, transactionId, idempotencyKey: "payment-key-0002" }), { code: "PAYMENT_UNAVAILABLE" });
  assert.equal(state.attempt, null);
});

test("invalid webhook signatures cannot create inbox rows or change payment state", async () => {
  const { prisma, state } = fixture();
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  await assert.rejects(service.receiveWebhook({ provider: adapter.providerId, rawBody: Buffer.from("{}"), signature: "00" }), { code: "RESOURCE_NOT_FOUND" });
  assert.equal(state.webhooks.length, 0);
  assert.equal(state.attempt, null);
});

test("verified webhook checks amount, currency and reference before changing attempt", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const rawBody = Buffer.from(JSON.stringify({ eventId: "event-1", providerReference: "ref-1", outcome: "CAPTURED", amountMinor: "5500", currency: "USD", occurredAt: "2026-11-04T00:00:00Z" }));
  const result = await service.receiveWebhook({ provider: adapter.providerId, rawBody, signature: adapter.signTestEvent(rawBody) });
  assert.equal(result.status, "CAPTURED");
  assert.equal(state.attempt.status, "CAPTURED");
  assert.equal(state.webhooks.at(-1).status, "PROCESSED");
  assert.equal(state.audits.at(-1).metadata.amountMinor, "5500");
});

test("duplicate and out-of-order webhook events are idempotent and never regress terminal state", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const event = async (eventId, outcome) => {
    const rawBody = Buffer.from(JSON.stringify({ eventId, providerReference: "ref-1", outcome, amountMinor: "5500", currency: "USD" }));
    return service.receiveWebhook({ provider: adapter.providerId, rawBody, signature: adapter.signTestEvent(rawBody) });
  };
  const first = await event("event-capture", "CAPTURED");
  assert.equal(first.status, "CAPTURED");
  const duplicate = await event("event-capture", "CAPTURED");
  assert.equal(duplicate.duplicate, true);
  const lateFailureRaw = Buffer.from(JSON.stringify({ eventId: "event-late-failure", providerReference: "ref-1", outcome: "FAILED", final: true, noCapture: true, amountMinor: "5500", currency: "USD" }));
  const lateFailure = await service.receiveWebhook({ provider: adapter.providerId, rawBody: lateFailureRaw, signature: adapter.signTestEvent(lateFailureRaw) });
  assert.equal(lateFailure.reconciliationRequired, true);
  assert.equal(state.attempt.status, "CAPTURED");
  assert.equal(state.webhooks.at(-1).status, "FAILED");
});

test("nonterminal failure claims are quarantined and cannot satisfy cancellation evidence", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const rawBody = Buffer.from(JSON.stringify({ eventId: "event-ambiguous", providerReference: "ref-1", outcome: "FAILED", amountMinor: "5500", currency: "USD" }));
  const result = await service.receiveWebhook({ provider: adapter.providerId, rawBody, signature: adapter.signTestEvent(rawBody) });
  assert.equal(result.reconciliationRequired, true);
  assert.equal(state.attempt.status, "PENDING");
  assert.equal(state.webhooks[0].status, "FAILED");
});

test("verified webhook with mismatched money is rejected without an attempt update", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const rawBody = Buffer.from(JSON.stringify({ eventId: "event-2", providerReference: "ref-1", outcome: "CAPTURED", amountMinor: "5501", currency: "USD" }));
  await assert.rejects(service.receiveWebhook({ provider: adapter.providerId, rawBody, signature: adapter.signTestEvent(rawBody) }), { code: "PAYMENT_EVENT_MISMATCH" });
  assert.equal(state.attempt.status, "PENDING");
});

test("provider status reconciliation requires verified matching evidence and records its provenance", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const base = createDeterministicPaymentTestAdapter();
  const adapter = { ...base, async fetchPaymentStatus() { return { verified: true, providerReference: "ref-1", outcome: "FAILED", amountMinor: "5500", currency: "USD", final: true, noCapture: true }; } };
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const result = await service.reconcile({ paymentAttemptId: state.attempt.id });
  assert.equal(result.status, "FAILED");
  assert.equal(state.attempt.status, "FAILED");
  assert.equal(state.webhooks[0].eventData.source, "STATUS_LOOKUP");
  assert.equal(state.webhooks[0].eventData.final, true);
});

test("unverified status lookup cannot change a payment outcome", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "ref-1", amountMinor: 5500n, currency: "USD", status: "PENDING" };
  const adapter = createDeterministicPaymentTestAdapter();
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  await assert.rejects(service.reconcile({ paymentAttemptId: state.attempt.id }), { code: "PAYMENT_EVENT_UNVERIFIED" });
  assert.equal(state.attempt.status, "PENDING");
  assert.equal(state.webhooks.length, 0);
});

test("signed checkout callback is confirmed by provider API before capture is persisted", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "razorpay", providerReference: "order_1", amountMinor: 5500n, currency: "INR", status: "PENDING", createdAt: new Date(), updatedAt: new Date() };
  prisma.paymentAttempt.findFirst = async () => state.attempt;
  const base = createDeterministicPaymentTestAdapter();
  const adapter = { ...base, providerId: "razorpay", verifyPaymentSignature: () => true, fetchPaymentDetails: async () => ({ paymentId: "pay_1", orderId: "order_1", amountMinor: "5500", currency: "INR", status: "captured" }) };
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  const result = await service.verifyPaymentCallback({ auth: { userId: buyerId, authVersion: 4, role: "USER" }, paymentAttemptId: "attempt-1", orderId: "order_1", paymentId: "pay_1", signature: "a".repeat(64) });
  assert.equal(result.captured, true);
  assert.equal(state.attempt.status, "CAPTURED");
  assert.equal(state.attempt.capturedPaymentId, "pay_1");
  assert.equal(state.webhooks[0].eventType, "payment.checkout_verified");
  assert.equal(state.audits[0].action, "PAYMENT_ATTEMPT_CAPTURE_VERIFIED");
});

test("checkout signature mismatch or provider amount mismatch cannot mark capture", async () => {
  const { prisma, state } = fixture();
  state.attempt = { id: "attempt-1", transactionId, provider: "trustbridge-test", providerReference: "order_1", amountMinor: 5500n, currency: "INR", status: "PENDING", createdAt: new Date(), updatedAt: new Date() };
  prisma.paymentAttempt.findFirst = async () => state.attempt;
  const base = createDeterministicPaymentTestAdapter();
  const adapter = { ...base, verifyPaymentSignature: () => true, fetchPaymentDetails: async () => ({ paymentId: "pay_1", orderId: "order_1", amountMinor: "5501", currency: "INR", status: "captured" }) };
  const service = createPaymentService({ getClient: async () => prisma, adapter, provider: adapter.providerId, enabled: true });
  await assert.rejects(service.verifyPaymentCallback({ auth: { userId: buyerId, authVersion: 4, role: "USER" }, paymentAttemptId: "attempt-1", orderId: "order_1", paymentId: "pay_1", signature: "b".repeat(64) }), { code: "PAYMENT_EVENT_MISMATCH" });
  assert.equal(state.attempt.status, "PENDING");
  const badAdapter = { ...adapter, verifyPaymentSignature: () => false };
  const bad = createPaymentService({ getClient: async () => prisma, adapter: badAdapter, provider: badAdapter.providerId, enabled: true });
  await assert.rejects(bad.verifyPaymentCallback({ auth: { userId: buyerId, authVersion: 4, role: "USER" }, paymentAttemptId: "attempt-1", orderId: "order_1", paymentId: "pay_1", signature: "b".repeat(64) }), (error) => error.statusCode === 404);
});
