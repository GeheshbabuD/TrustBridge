import assert from "node:assert/strict";
import express from "express";
import test from "node:test";
import { createPaymentRouter } from "../../src/routes/payment.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { MemoryRateLimitStore } from "../../src/services/rate-limit-store.service.js";

const txId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const auth = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "USER", status: "ACTIVE", authVersion: 2 };
const environment = { nodeEnv: "test", rateLimit: { windowMs: 60000, max: 100, keySecret: "test-payment-rate-limit-key" }, integrations: { payment: { enabled: true, provider: "trustbridge-test" } } };
const createHttpApp = ({ service, calls, activeEnvironment = environment, rateLimitStore = new MemoryRateLimitStore() }) => {
  const app = express();
  app.use(express.json({ verify(request, _response, body) { if (request.originalUrl.startsWith("/api/v1/webhooks/")) request.rawBody = Buffer.from(body); } }));
  app.use("/api/v1", createPaymentRouter({ environment: activeEnvironment, rateLimitStore, paymentService: service, authenticationMiddleware: (request, _response, next) => { request.auth = auth; next(); }, getClient: async () => ({
    transaction: { findUnique: async () => ({ id: txId, buyerId: auth.userId, sellerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }) },
    paymentAttempt: { findUnique: async () => ({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", transaction: { id: txId, buyerId: auth.userId, sellerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } }) },
    transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
  }) }));
  app.use((request, _response, next) => { request.requestId = "request-test"; next(); });
  app.use(errorHandler);
  return app;
};

const withServer = async (app, run) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
};

test("payment initiation HTTP contract rejects client monetary fields and returns safe accepted data", async () => {
  const calls = [];
  const service = { initiate: async (input) => { calls.push(input); return { accepted: true, attempt: { id: "attempt-safe", status: "PENDING", amountMinor: "5500", currency: "USD" } }; } };
  await withServer(createHttpApp({ service, calls }), async (base) => {
    const tampered = await fetch(`${base}/api/v1/transactions/${txId}/payment-attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "payment-key-0001" }, body: JSON.stringify({ amountMinor: 1, currency: "EUR", providerReference: "fake", status: "CAPTURED" }) });
    assert.equal(tampered.status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(`${base}/api/v1/transactions/${txId}/payment-attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "payment-key-0002" }, body: "{}" });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.data.attempt.status, "PENDING");
    assert.equal("providerReference" in body.data.attempt, false);
    assert.equal(calls[0].auth.userId, auth.userId);
  });
});

test("webhook HTTP route passes exact raw bytes to processor and acknowledges durable acceptance", async () => {
  let received;
  const service = { receiveWebhook: async (input) => { received = input; return { accepted: true, duplicate: false }; } };
  await withServer(createHttpApp({ service, calls: [] }), async (base) => {
    const raw = '{ "eventId":"evt-1", "payload": {"a":1} }';
    const response = await fetch(`${base}/api/v1/webhooks/trustbridge-test`, { method: "POST", headers: { "content-type": "application/json", "x-payment-signature": "test-signature" }, body: raw });
    assert.equal(response.status, 200);
    assert.equal(received.provider, "trustbridge-test");
    assert.equal(received.rawBody.toString("utf8"), raw);
    assert.equal(received.signature, "test-signature");
  });
});

test("payment webhook forwards Razorpay event identity and checkout verification is participant-authenticated", async () => {
  let webhookInput;
  let verificationInput;
  const service = {
    receiveWebhook: async (input) => { webhookInput = input; return { accepted: true, duplicate: false }; },
    verifyPaymentCallback: async (input) => { verificationInput = input; return { verified: true, captured: false }; },
  };
  await withServer(createHttpApp({ service, calls: [] }), async (base) => {
    const raw = '{"event":"payment.authorized"}';
    const hook = await fetch(`${base}/api/v1/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": "f".repeat(64), "x-razorpay-event-id": "evt_123" }, body: raw });
    assert.equal(hook.status, 200);
    assert.equal(webhookInput.eventId, "evt_123");
    assert.equal(webhookInput.signature, "f".repeat(64));
    const attemptId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const verify = await fetch(`${base}/api/v1/payment-attempts/${attemptId}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "order_123", paymentId: "pay_123", signature: "a".repeat(64) }) });
    assert.equal(verify.status, 200);
    assert.equal(verificationInput.auth.userId, auth.userId);
    assert.equal(verificationInput.paymentAttemptId, attemptId);
  });
});

test("production payment routes fail closed when shared rate-limit storage is absent", async () => {
  const activeEnvironment = { nodeEnv: "production", integrations: { payment: { enabled: true, provider: "trustbridge-test" } } };
  const service = { async receiveWebhook() { assert.fail("storage failure must reject before payment processing"); } };
  await withServer(createHttpApp({ service, calls: [], activeEnvironment, rateLimitStore: null }), async (base) => {
    const response = await fetch(`${base}/api/v1/webhooks/trustbridge-test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "RATE_LIMIT_STORE_UNAVAILABLE");
  });
});
