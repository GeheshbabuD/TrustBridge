import test from "node:test";
import assert from "node:assert/strict";
import { createRazorpayEscrowExecutors } from "../../src/services/razorpay-escrow.executor.js";

const captured = { id: "attempt-1", transactionId: "tx-1", provider: "razorpay", status: "CAPTURED", capturedPaymentId: "pay_1", amountMinor: 5000n, currency: "INR" };

test("refund executor resumes by persisted provider refund ID and never repeats provider creation", async () => {
  const calls = []; const saved = [];
  const adapter = {
    providerId: "razorpay",
    async createRefund(input) { calls.push(["create", input]); return { refundId: "rfnd_1", paymentId: "pay_1", amountMinor: "5000", currency: "INR", status: "pending" }; },
    async fetchRefund(input) { calls.push(["fetch", input]); return { refundId: "rfnd_1", paymentId: "pay_1", amountMinor: "5000", currency: "INR", status: "processed" }; },
  };
  const executors = createRazorpayEscrowExecutors({ getClient: async () => ({ escrowOperation: { findFirst: async () => ({ paymentAttempt: captured }) } }), adapter, refundsApproved: true });
  const input = { operationId: "op-1", transactionId: "tx-1", amountMinor: "5000", currency: "INR", idempotencyKey: "RELEASE:tx-1:key", persistProviderReference: async (value) => saved.push(value) };
  const first = await executors.refund(input);
  assert.equal(first.outcome, "SUCCEEDED");
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  assert.equal(calls[0][1].paymentId, "pay_1");
  assert.equal(calls[0][1].financialContext.approved, undefined);
  assert.equal(saved[0].providerReference, "rfnd_1");
  const resumed = await executors.refund({ ...input, providerReference: "rfnd_1" });
  assert.equal(resumed.providerReference, "rfnd_1");
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
});

test("refund executor fails closed when a captured Razorpay payment reference is absent", async () => {
  const executors = createRazorpayEscrowExecutors({ getClient: async () => ({ escrowOperation: { findFirst: async () => ({ paymentAttempt: { ...captured, capturedPaymentId: null } }) } }), adapter: { providerId: "razorpay" }, refundsApproved: true });
  await assert.rejects(executors.refund({ transactionId: "tx-1", amountMinor: "5000", currency: "INR" }), /CAPTURE_REFERENCE_UNAVAILABLE/);
});

test("Route release executor uses only the persisted capture and server-resolved linked account", async () => {
  const calls = []; const adapter = {
    providerId: "razorpay",
    async createRouteTransfer(input) { calls.push(["create", input]); return { transferId: "trf_1", paymentId: "pay_1", accountId: "acc_seller", amountMinor: "5000", currency: "INR" }; },
    async fetchRouteTransfer(input) { calls.push(["fetch", input]); return { transferId: "trf_1", paymentId: "pay_1", accountId: "acc_seller", amountMinor: "5000", currency: "INR", settlementStatus: "settled", status: "processed" }; },
  };
  const executors = createRazorpayEscrowExecutors({ getClient: async () => ({
    escrowOperation: { findUnique: async () => ({ transaction: { sellerId: "seller-1" } }), findFirst: async () => ({ paymentAttempt: captured }) },
  }), adapter, resolveRouteAccount: async ({ sellerId }) => sellerId === "seller-1" ? "acc_seller" : null, routeApproved: true });
  const result = await executors.release({ operationId: "op-2", transactionId: "tx-1", amountMinor: "5000", currency: "INR", idempotencyKey: "RELEASE:tx-1:key", persistProviderReference: async () => {} });
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal(calls[0][1].paymentId, "pay_1");
  assert.equal(calls[0][1].accountId, "acc_seller");
  assert.equal(calls[1][0], "fetch");
});

test("Route release rejects a fetched transfer linked to another captured payment", async () => {
  const adapter = {
    providerId: "razorpay",
    async createRouteTransfer() { return { transferId: "trf_1", paymentId: "pay_1", accountId: "acc_seller", amountMinor: "5000", currency: "INR" }; },
    async fetchRouteTransfer() { return { transferId: "trf_1", paymentId: "pay_other", accountId: "acc_seller", amountMinor: "5000", currency: "INR", settlementStatus: "settled", status: "processed" }; },
  };
  const executors = createRazorpayEscrowExecutors({ getClient: async () => ({
    escrowOperation: { findUnique: async () => ({ transaction: { sellerId: "seller-1" } }), findFirst: async () => ({ paymentAttempt: captured }) },
  }), adapter, resolveRouteAccount: async () => "acc_seller", routeApproved: true });
  const input = { operationId: "op-2", transactionId: "tx-1", amountMinor: "5000", currency: "INR", idempotencyKey: "RELEASE:tx-1:key", persistProviderReference: async () => {} };
  await assert.rejects(executors.release(input), /PROVIDER_RESULT_INVALID/);
});

test("Route release stays pending until provider reports processed and settled", async () => {
  const adapter = {
    providerId: "razorpay",
    async createRouteTransfer() { return { transferId: "trf_1", paymentId: "pay_1", accountId: "acc_seller", amountMinor: "5000", currency: "INR" }; },
    async fetchRouteTransfer() { return { transferId: "trf_1", paymentId: "pay_1", accountId: "acc_seller", amountMinor: "5000", currency: "INR", settlementStatus: "pending", status: "processed" }; },
  };
  const executors = createRazorpayEscrowExecutors({ getClient: async () => ({
    escrowOperation: { findUnique: async () => ({ transaction: { sellerId: "seller-1" } }), findFirst: async () => ({ paymentAttempt: captured }) },
  }), adapter, resolveRouteAccount: async () => "acc_seller", routeApproved: true });
  const result = await executors.release({ operationId: "op-2", transactionId: "tx-1", amountMinor: "5000", currency: "INR", idempotencyKey: "RELEASE:tx-1:key", persistProviderReference: async () => {} });
  assert.deepEqual(result, { verified: false, outcome: "PENDING", provider: "razorpay", providerReference: "trf_1" });
});
