import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createTransactionRouter } from "../../src/routes/transaction.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

const transactionId = "33333333-3333-4333-8333-333333333333";
const ids = { BUYER: "11111111-1111-4111-8111-111111111111", SELLER: "22222222-2222-4222-8222-222222222222", ADMIN: "55555555-5555-4555-8555-555555555555" };
test("delivery HTTP routes validate input and preserve authenticated participant identity", async (t) => {
  const calls = [];
  const auth = (req, _res, next) => { const role = req.get("x-test-user"); req.auth = { userId: ids[role], role, status: "ACTIVE", authVersion: 0 }; req.requestId = "delivery-http"; next(); };
  const participant = (userId) => ({ async startWork(input) { calls.push(["start", input]); return { transactionId, status: "IN_PROGRESS" }; }, async submitDelivery(input) { calls.push(["submit", input]); return { id: "delivery-id", sequence: 1 }; }, async decideDelivery(input) { calls.push(["decision", input]); return { deliveryId: input.deliveryId, decision: input.decision }; }, async getHistory(input) { calls.push(["history", input]); return []; } });
  const db = async () => ({ transaction: { findUnique: async () => ({ id: transactionId, buyerId: ids.BUYER, sellerId: ids.SELLER }) }, transactionParticipant: { findUnique: async ({ where }) => Object.values(ids).includes(where.transactionId_userId.userId) && where.transactionId_userId.userId !== ids.ADMIN ? { role: where.transactionId_userId.userId === ids.SELLER ? "SELLER" : "BUYER" } : null } });
  const app = express(); app.use(express.json()); app.use(createTransactionRouter({ authenticationMiddleware: auth, transactionService: {}, transactionDeliveryService: participant(), getClient: db })); app.use(errorHandler);
  const server = app.listen(0); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const invalid = await fetch(`${base}/transactions/${transactionId}/deliveries`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "SELLER" }, body: JSON.stringify({ expectedVersion: 0, description: "x", status: "COMPLETED" }) });
  assert.equal(invalid.status, 400);
  const submitted = await fetch(`${base}/transactions/${transactionId}/deliveries`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "SELLER" }, body: JSON.stringify({ expectedVersion: 5, description: "Completed work" }) });
  assert.equal(submitted.status, 201); assert.equal(calls.find(([kind]) => kind === "submit")[1].auth.userId, ids.SELLER);
  const decision = await fetch(`${base}/transactions/${transactionId}/deliveries/decision`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER" }, body: JSON.stringify({ deliveryId: "44444444-4444-4444-8444-444444444444", expectedVersion: 6, decision: "CHANGES_REQUESTED", reason: "Please revise" }) });
  assert.equal(decision.status, 200); assert.equal(calls.find(([kind]) => kind === "decision")[1].auth.userId, ids.BUYER);
  const admin = await fetch(`${base}/transactions/${transactionId}/deliveries`, { headers: { "x-test-user": "ADMIN" } }); assert.equal(admin.status, 404);
});
