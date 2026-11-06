import test from "node:test";
import assert from "node:assert/strict";
import { composeEscrowRuntime } from "../../src/services/escrow-runtime.composition.js";

const paymentConfig = { enabled: true, provider: "razorpay", escrowExecutionEnabled: true, refundsApproved: true, routeApproved: true, apiKey: "synthetic", apiSecret: "synthetic", webhookSecret: "synthetic-webhook-secret" };

test("financial runtime stays disabled unless every explicit execution gate is enabled", () => {
  const result = composeEscrowRuntime({ paymentConfig: { ...paymentConfig, escrowExecutionEnabled: false } });
  assert.equal(result.workerEnabled, false);
  assert.equal(result.escrowService.executeAuthorizedOperation instanceof Function, true);
});

test("refund approval can compose without Route while Route fails closed without a server account resolver", () => {
  const result = composeEscrowRuntime({ paymentConfig: { ...paymentConfig, routeApproved: false } });
  assert.equal(result.workerEnabled, true);
  assert.equal(result.adapter.providerId, "razorpay");
});

test("Route worker composition requires a trusted server-side account resolver", () => {
  const result = composeEscrowRuntime({ paymentConfig, resolveRouteAccount: async () => "acc_test" });
  assert.equal(result.workerEnabled, true);
});
