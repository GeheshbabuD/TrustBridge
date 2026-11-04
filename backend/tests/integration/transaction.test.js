import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { ApiError } from "../../src/utils/ApiError.js";
import { createTransactionRouter } from "../../src/routes/transaction.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

const transactionId = "33333333-3333-4333-8333-333333333333";
const buyerId = "11111111-1111-4111-8111-111111111111";
const sellerId = "22222222-2222-4222-8222-222222222222";
const publicTransaction = { id: transactionId, buyerId, sellerId, status: "CREATED", amountMinor: "500", currency: "INR", terms: { description: "Work" }, version: 1 };
const withServer = async (app, run) => {
  const server = app.listen(0); await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
};

test("transaction HTTP routes enforce role, participant ownership, validation and safe serialization", async () => {
  const calls = [];
  const userIds = { BUYER: buyerId, SELLER: sellerId, OUTSIDER: "44444444-4444-4444-8444-444444444444", ADMIN: "55555555-5555-4555-8555-555555555555" };
  const authenticationMiddleware = (request, _response, next) => {
    const role = request.get("x-test-user");
    if (!role) return next(Object.assign(new Error("unauthenticated"), { statusCode: 401, code: "AUTHENTICATION_REQUIRED" }));
    request.auth = { userId: userIds[role], role: role === "ADMIN" ? "ADMIN" : "USER", status: "ACTIVE", authVersion: 0 };
    request.requestId = "req-test";
    return next();
  };
  const transactionService = {
    async create(input) { calls.push(["create", input]); return publicTransaction; },
    async listForUser(input) { calls.push(["list", input]); return { transactions: [publicTransaction], nextCursor: null }; },
    async getForParticipant(input) { calls.push(["get", input]); return publicTransaction; },
    async getHistory(input) { calls.push(["history", input]); return { history: [], nextCursor: null }; },
    async getTerms(input) { calls.push(["terms", input]); return { versions: [] }; },
    async proposeTerms(input) { calls.push(["terms.propose", input]); return { id: "terms-version", version: 2, status: "PENDING" }; },
    async decideTerms(input) { calls.push(["terms.decide", input]); return { id: "terms-version", version: input.version, status: input.decision }; },
    async createInvitation(input) { calls.push(["invitation.create", input]); return { invitation: { id: "invitation-id", status: "PENDING", expiresAt: new Date().toISOString() }, invitationToken: "x".repeat(43) }; },
    async respondToInvitation(input) { calls.push(["invitation.respond", input]); return { invitation: { id: "invitation-id", status: input.decision }, transaction: publicTransaction }; },
    async transition(input) {
      calls.push(["transition", input]);
      if (input.status === "CANCELLED" && input.expectedVersion === 3) throw new ApiError(409, "PAYMENT_OUTCOME_UNVERIFIED", "Transaction operation conflicts with current state");
      if (input.status === "CANCELLED" && input.expectedVersion === 4) throw new ApiError(503, "TRANSACTION_STORAGE_UNAVAILABLE", "Transaction service is temporarily unavailable");
      return { ...publicTransaction, status: input.status, version: 2 };
    },
  };
  const getClient = async () => ({
    transaction: { findUnique: async () => ({ id: transactionId, buyerId, sellerId }) },
    transactionParticipant: { findUnique: async ({ where }) => {
      const uid = where.transactionId_userId.userId;
      return uid === buyerId ? { role: "BUYER" } : uid === sellerId ? { role: "SELLER" } : null;
    } },
  });
  const app = express(); app.use(express.json());
  app.use(createTransactionRouter({ authenticationMiddleware, transactionService, getClient })); app.use(errorHandler);

  await withServer(app, async (base) => {
    const body = { sellerId, amountMinor: "500", currency: "INR", terms: { description: "Work" } };
    assert.equal((await fetch(`${base}/transactions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER", "idempotency-key": "transaction-key-123" }, body: JSON.stringify(body) })).status, 201);
    const createdCall = calls.find(([name]) => name === "create")[1];
    assert.equal(createdCall.auth.userId, buyerId);
    assert.equal(createdCall.input.sellerId, sellerId);
    assert.equal(createdCall.idempotencyKey, "transaction-key-123");

    const injected = await fetch(`${base}/transactions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "ADMIN", "idempotency-key": "transaction-key-123" }, body: JSON.stringify(body) });
    assert.equal(injected.status, 403);
    const invalid = await fetch(`${base}/transactions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER", "idempotency-key": "transaction-key-123" }, body: JSON.stringify({ ...body, status: "FUNDED" }) });
    assert.equal(invalid.status, 400);

    const owner = await fetch(`${base}/transactions/${transactionId}`, { headers: { "x-test-user": "SELLER" } });
    assert.equal(owner.status, 200);
    const ownerBody = await owner.json();
    assert.equal(ownerBody.data.transaction.amountMinor, "500");
    assert.equal("paymentAttempts" in ownerBody.data.transaction, false);
    const denied = await fetch(`${base}/transactions/${transactionId}`, { headers: { "x-test-user": "OUTSIDER" } });
    assert.equal(denied.status, 404);
    const history = await fetch(`${base}/transactions/${transactionId}/history`, { headers: { "x-test-user": "BUYER" } });
    assert.equal(history.status, 200);
    const terms = await fetch(`${base}/transactions/${transactionId}/terms`, { headers: { "x-test-user": "BUYER" } });
    assert.equal(terms.status, 200);
    const proposal = await fetch(`${base}/transactions/${transactionId}/terms/versions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER" }, body: JSON.stringify({ amountMinor: "500", currency: "INR", terms: { description: "Work" } }) });
    assert.equal(proposal.status, 201);
    const invitation = await fetch(`${base}/transactions/${transactionId}/invitations`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER" }, body: JSON.stringify({ inviteeId: sellerId }) });
    assert.equal(invitation.status, 201);
    assert.equal((await invitation.json()).data.invitationToken, "x".repeat(43));
    const termsDecision = await fetch(`${base}/transactions/${transactionId}/terms/decisions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "SELLER" }, body: JSON.stringify({ version: 2, decision: "ACCEPTED" }) });
    assert.equal(termsDecision.status, 200);
    const invitationResponse = await fetch(`${base}/transaction-invitations/accept`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "SELLER" }, body: JSON.stringify({ token: "x".repeat(43), expectedVersion: 1 }) });
    assert.equal(invitationResponse.status, 200);
    assert.equal(calls.find(([name]) => name === "invitation.respond")[1].auth.userId, sellerId);
    const transition = await fetch(`${base}/transactions/${transactionId}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "SELLER" }, body: JSON.stringify({ status: "ACCEPTED", expectedVersion: 1 }) });
    assert.equal(transition.status, 200);
    assert.equal(calls.some(([name]) => name === "transition"), true);
    const blockedCancel = await fetch(`${base}/transactions/${transactionId}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER" }, body: JSON.stringify({ status: "CANCELLED", expectedVersion: 3 }) });
    assert.equal(blockedCancel.status, 409);
    assert.deepEqual((await blockedCancel.json()).error, { code: "PAYMENT_OUTCOME_UNVERIFIED" });
    const unavailable = await fetch(`${base}/transactions/${transactionId}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "BUYER" }, body: JSON.stringify({ status: "CANCELLED", expectedVersion: 4 }) });
    assert.equal(unavailable.status, 503);
    assert.deepEqual((await unavailable.json()).error, { code: "TRANSACTION_STORAGE_UNAVAILABLE" });
  });
});
