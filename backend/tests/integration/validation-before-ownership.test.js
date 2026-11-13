import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createTransactionRouter } from "../../src/routes/transaction.routes.js";
import { createPaymentRouter } from "../../src/routes/payment.routes.js";
import { createEscrowRouter } from "../../src/routes/escrow.routes.js";
import { createDisputeRouter } from "../../src/routes/dispute.routes.js";
import { createNotificationRouter } from "../../src/routes/notification.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

const ids = {
  transaction: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  dispute: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  evidence: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  notification: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  owner: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
};

const withHttp = async (router, run) => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { userId: request.get("x-user") === "other" ? ids.other : ids.owner, role: request.get("x-role") ?? "USER", status: "ACTIVE", authVersion: 0 };
    next();
  });
  app.use(router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
};

const participantClient = (counts, { owned = true } = {}) => ({
  transaction: { findUnique: async () => { counts.transaction += 1; return { id: ids.transaction, buyerId: ids.owner, sellerId: ids.other }; } },
  transactionParticipant: { findUnique: async ({ where }) => { counts.participant += 1; return (owned ? where.transactionId_userId.userId === ids.owner : false) ? { role: "BUYER" } : null; } },
});
const auth = (_request, _response, next) => next();

test("transaction and history syntax is rejected before ownership lookup; valid IDs retain ownership enforcement", async () => {
  const counts = { transaction: 0, participant: 0 }; const calls = [];
  const appRouter = createTransactionRouter({ authenticationMiddleware: auth, getClient: async () => participantClient(counts),
    transactionService: { getForParticipant: async (input) => { calls.push(input); return { id: ids.transaction }; }, getHistory: async (input) => { calls.push(input); return { history: [] }; } },
    transactionDeliveryService: {},
  });
  await withHttp(appRouter, async (base) => {
    assert.equal((await fetch(`${base}/transactions/not-a-uuid`)).status, 400);
    assert.equal((await fetch(`${base}/transactions/${ids.transaction}/history?limit=0`)).status, 400);
    assert.deepEqual(counts, { transaction: 0, participant: 0 });
    assert.equal((await fetch(`${base}/transactions/${ids.transaction}` , { headers: { "x-user": "other" } })).status, 404);
    assert.equal(counts.transaction, 1);
    assert.equal((await fetch(`${base}/transactions/${ids.transaction}`)).status, 200);
    assert.equal(calls.length, 1);
  });
});

test("payment and escrow resource syntax is rejected before participant lookup", async () => {
  const counts = { transaction: 0, participant: 0, paymentAttempt: 0 }; const calls = [];
  const getClient = async () => ({ ...participantClient(counts), paymentAttempt: { findUnique: async () => { counts.paymentAttempt += 1; return null; } } });
  const payment = createPaymentRouter({ authenticationMiddleware: auth, getClient, paymentService: { initiate: async (input) => { calls.push(input); return {}; } } });
  const escrow = createEscrowRouter({ authenticationMiddleware: auth, getClient, escrowService: { getStatus: async () => ({ status: "NOT_FUNDED" }) }, stepUpAuthorizationMiddlewareFactory: () => (_req, _res, next) => next() });
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => { request.auth = { userId: request.get("x-user") === "other" ? ids.other : ids.owner, role: request.get("x-role") ?? "USER", status: "ACTIVE", authVersion: 0 }; next(); });
  app.use(payment); app.use(escrow); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/transactions/bad/payment-attempts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "payment-key-123" }, body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/payment-attempts/bad`, { headers: { "x-user": "other" } })).status, 400);
    assert.equal((await fetch(`${base}/payment-attempts/${ids.transaction}/verify`, { method: "POST", headers: { "content-type": "application/json", "x-user": "other" }, body: JSON.stringify({ orderId: "order_1", paymentId: "pay_1", signature: "a".repeat(64) }) })).status, 404);
    assert.equal((await fetch(`${base}/transactions/bad/escrow`, { headers: { "x-user": "other" } })).status, 400);
    assert.equal(counts.transaction, 0);
    assert.equal(counts.paymentAttempt, 1);
    assert.equal(calls.length, 0);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("dispute, evidence and admin evidence syntax is rejected before binding or ownership lookups", async () => {
  const counts = { transaction: 0, participant: 0, dispute: 0, evidence: 0 }; const calls = [];
  const getClient = async () => ({ ...participantClient(counts),
    dispute: { findUnique: async () => { counts.dispute += 1; return { id: ids.dispute, transaction: { id: ids.transaction, buyerId: ids.owner, sellerId: ids.other } }; } },
    evidence: { findUnique: async () => { counts.evidence += 1; return { id: ids.evidence, disputeId: ids.dispute, dispute: { transaction: { id: ids.transaction, buyerId: ids.owner, sellerId: ids.other } } }; } },
  });
  const service = Object.fromEntries(["create", "get", "respond", "uploadEvidence", "downloadEvidence", "startReview", "resolve"].map((name) => [name, async (input) => { calls.push([name, input]); return { id: ids.dispute }; }]));
  const router = createDisputeRouter({ authenticationMiddleware: auth, getClient, disputeService: service, stepUpAuthorizationMiddlewareFactory: () => (_req, _res, next) => next() });
  await withHttp(router, async (base) => {
    assert.equal((await fetch(`${base}/disputes/not-a-uuid`)).status, 400);
    assert.equal((await fetch(`${base}/disputes/${ids.dispute}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unknown: true }) })).status, 400);
    assert.equal((await fetch(`${base}/disputes/${ids.dispute}/evidence`, { method: "POST", headers: { "content-type": "image/png", "x-evidence-category": "BAD" }, body: Buffer.from("x") })).status, 400);
    assert.equal((await fetch(`${base}/admin/dispute-evidence/not-a-uuid`, { headers: { "x-role": "ADMIN" } })).status, 400);
    assert.deepEqual(counts, { transaction: 0, participant: 0, dispute: 0, evidence: 0 });
    assert.equal((await fetch(`${base}/disputes/${ids.dispute}`, { headers: { "x-user": "other" } })).status, 404);
    assert.equal(counts.dispute, 1);
  });
});

test("notification ID syntax is rejected before recipient lookup and valid IDs remain recipient-scoped", async () => {
  let lookups = 0; let reads = 0;
  const router = createNotificationRouter({ authenticationMiddleware: auth, getClient: async () => ({ notification: { findUnique: async () => { lookups += 1; return { id: ids.notification, recipientId: ids.owner }; } } }),
    notificationService: { listMine: async () => ({ notifications: [] }), markRead: async () => { reads += 1; return { id: ids.notification }; } } });
  await withHttp(router, async (base) => {
    assert.equal((await fetch(`${base}/notifications/not-a-uuid/read`, { method: "PATCH" })).status, 400);
    assert.equal(lookups, 0);
    assert.equal((await fetch(`${base}/notifications/${ids.notification}/read`, { method: "PATCH", headers: { "x-user": "other" } })).status, 404);
    assert.equal(lookups, 1); assert.equal(reads, 0);
    assert.equal((await fetch(`${base}/notifications/${ids.notification}/read`, { method: "PATCH" })).status, 200);
    assert.equal(reads, 1);
  });
});
