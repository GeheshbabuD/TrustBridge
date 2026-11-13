import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createRazorpayPaymentAdapter } from "../../src/services/razorpay-payment.adapter.js";

const jsonResponse = (data, ok = true) => ({ ok, async json() { return data; } });
const options = { apiKey: "rzp_test_key", apiSecret: "synthetic-api-secret", webhookSecret: "synthetic-webhook-secret", enabled: true };
const signature = (secret, value) => createHmac("sha256", secret).update(value).digest("hex");

test("order creation uses integer paise, INR and stable receipt, and recovers an ambiguous retry", async () => {
  const calls = [];
  let created = false;
  const adapter = createRazorpayPaymentAdapter({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/v1/orders?")) return jsonResponse({ items: created ? [{ id: "order_123", receipt: "attempt-1", amount: 12345, currency: "INR" }] : [] });
    if (init.method === "POST") { created = true; return jsonResponse({ id: "order_123", receipt: "attempt-1", amount: 12345, currency: "INR" }); }
    throw new Error("unexpected request");
  } });
  const first = await adapter.createPaymentIntent({ attemptId: "attempt-1", amountMinor: "12345", currency: "INR" });
  const retry = await adapter.createPaymentIntent({ attemptId: "attempt-1", amountMinor: "12345", currency: "INR" });
  assert.deepEqual(first, { providerReference: "order_123", status: "PENDING" });
  assert.deepEqual(retry, first);
  assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  assert.match(calls[0].url, /receipt=attempt-1/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { amount: 12345, currency: "INR", receipt: "attempt-1" });
});

test("order creation rejects non-INR, non-integer and unsafe amounts", async () => {
  const adapter = createRazorpayPaymentAdapter({ ...options, fetchImpl: async () => { throw new Error("should not call"); } });
  for (const input of [
    { attemptId: "a1", amountMinor: "1.5", currency: "INR" },
    { attemptId: "a1", amountMinor: "9007199254740992", currency: "INR" },
    { attemptId: "a1", amountMinor: "120", currency: "USD" },
  ]) await assert.rejects(adapter.createPaymentIntent(input), /RAZORPAY_OPERATION_UNAVAILABLE/);
});

test("disabled adapter does not issue network calls", async () => {
  let called = false;
  const adapter = createRazorpayPaymentAdapter({ ...options, enabled: false, fetchImpl: async () => { called = true; } });
  await assert.rejects(adapter.createPaymentIntent({ attemptId: "a1", amountMinor: "100", currency: "INR" }));
  assert.equal(called, false);
});

test("checkout configuration exposes only the public key ID and fails closed when disabled", () => {
  const adapter = createRazorpayPaymentAdapter({ ...options, apiKey: "rzp_test_public_key", apiSecret: "server-only-api-secret" });
  assert.deepEqual(adapter.getCheckoutConfiguration(), { key: "rzp_test_public_key" });
  assert.equal(JSON.stringify(adapter.getCheckoutConfiguration()).includes("server-only-api-secret"), false);
  const disabled = createRazorpayPaymentAdapter({ ...options, enabled: false });
  assert.throws(() => disabled.getCheckoutConfiguration(), /RAZORPAY_OPERATION_UNAVAILABLE/);
});

test("payment and raw-body webhook signatures verify with separate secrets", async () => {
  const adapter = createRazorpayPaymentAdapter({ ...options, fetchImpl: async () => jsonResponse({}) });
  assert.equal(adapter.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature: signature(options.apiSecret, "order_1|pay_1") }), true);
  assert.equal(adapter.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature: signature(options.webhookSecret, "order_1|pay_1") }), false);
  const raw = Buffer.from('{ "event":"payment.captured" }');
  assert.equal(await adapter.verifyWebhook({ rawBody: raw, signature: signature(options.webhookSecret, raw) }), true);
  assert.equal(await adapter.verifyWebhook({ rawBody: Buffer.from('{"event":"payment.captured"}'), signature: signature(options.webhookSecret, raw) }), false);
  assert.equal(await adapter.verifyWebhook({ rawBody: raw, signature: "bad" }), false);
});

test("webhook maps captured and failed payment events safely and requires event header", () => {
  const adapter = createRazorpayPaymentAdapter(options);
  const raw = Buffer.from(JSON.stringify({ event: "payment.failed", created_at: 100, payload: { payment: { entity: { order_id: "order_1", amount: 500, currency: "INR" } } } }));
  assert.equal(adapter.normalizeWebhook({ rawBody: raw }), null);
  const failed = adapter.normalizeWebhook({ rawBody: raw, headers: { eventId: "evt_1" } });
  assert.equal(failed.outcome, "PENDING");
  assert.equal(failed.final, false);
  const capturedRaw = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { order_id: "order_1", amount: 500, currency: "INR" } } } }));
  assert.equal(adapter.normalizeWebhook({ rawBody: capturedRaw, headers: { eventId: "evt_2" } }).outcome, "CAPTURED");
});

test("status lookup trusts only a matching captured payment; absence remains pending", async () => {
  let items = [{ id: "pay_1", order_id: "order_1", amount: 1000, currency: "INR", status: "captured" }];
  const adapter = createRazorpayPaymentAdapter({ ...options, fetchImpl: async () => jsonResponse({ items }) });
  const captured = await adapter.fetchPaymentStatus({ providerReference: "order_1", amountMinor: "1000", currency: "INR" });
  assert.equal(captured.outcome, "CAPTURED");
  items = [];
  const pending = await adapter.fetchPaymentStatus({ providerReference: "order_1", amountMinor: "1000", currency: "INR" });
  assert.equal(pending.outcome, "PENDING");
  assert.equal(pending.noCapture, false);
});

test("refund calls use documented idempotency and remain disabled without financial approval", async () => {
  const calls = [];
  const adapter = createRazorpayPaymentAdapter({ ...options, refundsEnabled: true, authorizeRefund: async () => true, fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse({ id: "rfnd_1", payment_id: "pay_1", amount: 500, currency: "INR", status: "pending" }); } });
  const refund = await adapter.createRefund({ paymentId: "pay_1", amountMinor: "500", idempotencyKey: "refund-key-001", financialContext: { approved: true } });
  assert.deepEqual(refund, { refundId: "rfnd_1", paymentId: "pay_1", amountMinor: "500", currency: "INR", status: "pending" });
  assert.equal(calls[0].init.headers["X-Refund-Idempotency"], "refund-key-001");
  const blocked = createRazorpayPaymentAdapter({ ...options, fetchImpl: async () => { throw new Error("must not call"); } });
  await assert.rejects(blocked.createRefund({ paymentId: "pay_1", idempotencyKey: "refund-key-001" }));
});

test("refund status fetch normalizes provider outcome without mutating payment state", async () => {
  const adapter = createRazorpayPaymentAdapter({ ...options, fetchImpl: async () => jsonResponse({ id: "rfnd_1", payment_id: "pay_1", status: "processed", amount: 900, currency: "INR" }) });
  assert.deepEqual(await adapter.fetchRefund({ paymentId: "pay_1", refundId: "rfnd_1" }), { refundId: "rfnd_1", paymentId: "pay_1", status: "processed", amountMinor: "900", currency: "INR" });
});

test("Route methods fail closed unless explicitly enabled and independently authorized", async () => {
  let called = false;
  const blocked = createRazorpayPaymentAdapter({ ...options, routeEnabled: true, fetchImpl: async () => { called = true; return jsonResponse({ id: "acc_1", type: "route" }); } });
  await assert.rejects(blocked.createRouteLinkedAccount({ payload: {} }));
  assert.equal(called, false);
  const adapter = createRazorpayPaymentAdapter({ ...options, routeEnabled: true, authorizeRoute: async () => true, fetchImpl: async () => jsonResponse({ id: "acc_1", type: "route", status: "created" }) });
  assert.deepEqual(await adapter.createRouteLinkedAccount({ payload: {}, financialContext: { approved: true } }), { accountId: "acc_1", status: "created" });
});

test("Route transfer is tied to the persisted payment and linked account and supports status reconciliation", async () => {
  const calls = [];
  const adapter = createRazorpayPaymentAdapter({ ...options, routeEnabled: true, authorizeRoute: async () => true, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST") return jsonResponse({ entity: "collection", items: [{ id: "trf_1", recipient: "acc_1", amount: 500, currency: "INR", transfer_status: "created" }] });
    return jsonResponse({ id: "trf_1", source: "pay_1", recipient: "acc_1", amount: 500, currency: "INR", transfer_status: "processed", settlement_status: "settled" });
  } });
  const created = await adapter.createRouteTransfer({ paymentId: "pay_1", accountId: "acc_1", amountMinor: "500", idempotencyKey: "0123456789abcdef0123456789abcdef", financialContext: {} });
  assert.equal(created.transferId, "trf_1");
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payments/pay_1/transfers");
  assert.equal(JSON.parse(calls[0].init.body).transfers[0].account, "acc_1");
  const status = await adapter.fetchRouteTransfer({ transferId: "trf_1" });
  assert.equal(status.status, "processed");
});

test("timeouts and provider errors are sanitized", async () => {
  const adapter = createRazorpayPaymentAdapter({ ...options, timeoutMs: 1, fetchImpl: async () => { throw new Error("secret upstream details"); } });
  await assert.rejects(adapter.fetchPaymentStatus({ providerReference: "order_1" }), (error) => error.message === "RAZORPAY_OPERATION_UNAVAILABLE");
});
