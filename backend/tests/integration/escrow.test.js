import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createEscrowRouter } from "../../src/routes/escrow.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const buyerAuth = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "USER", authVersion: 0, sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true };
const adminAuth = { ...buyerAuth, userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "ADMIN" };

const createHttp = ({ auth = buyerAuth, service, stepUpCalls = [] }) => {
  const app = express(); app.use(express.json());
  const getClient = async () => ({
    transaction: { findUnique: async () => ({ id: transactionId, buyerId: buyerAuth.userId, sellerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }) },
    transactionParticipant: { findUnique: async ({ where }) => where.transactionId_userId.userId === buyerAuth.userId ? { role: "BUYER" } : null },
  });
  app.use("/api/v1", createEscrowRouter({ escrowService: service, getClient,
    authenticationMiddleware: (request, _response, next) => { request.auth = auth; next(); },
    stepUpAuthorizationMiddlewareFactory: ({ purpose }) => (request, _response, next) => { stepUpCalls.push(purpose); next(); },
  }));
  app.use(errorHandler); return app;
};

const request = async (app, path, { method = "POST", body = { reasonCode: "BUYER_ACCEPTED_DELIVERY" } } = {}) => {
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try { return await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": "escrow-http-key-001" }, body: method === "GET" ? undefined : JSON.stringify(body) }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
};

test("release authorization HTTP requires participant and step-up and returns only operation metadata", async () => {
  const calls = []; const stepUpCalls = [];
  const app = createHttp({ service: { authorizeRelease: async (input) => { calls.push(input); return { operationId: "op-safe", status: "PENDING", duplicate: false }; } }, stepUpCalls });
  const response = await request(app, `/transactions/${transactionId}/escrow/release`);
  assert.equal(response.status, 202, await response.clone().text());
  assert.deepEqual(stepUpCalls, ["ESCROW_RELEASE"]);
  assert.equal(calls[0].auth.userId, buyerAuth.userId);
  const body = await response.json(); assert.equal(body.data.operation.operationId, "op-safe"); assert.equal("providerReference" in body.data.operation, false);
});

test("ADMIN without participant ownership cannot use release authorization", async () => {
  let called = false;
  const app = createHttp({ auth: adminAuth, service: { authorizeRelease: async () => { called = true; } } });
  const response = await request(app, `/transactions/${transactionId}/escrow/release`);
  assert.equal(response.status, 404); assert.equal(called, false);
});

test("refund authorization remains ADMIN-only and requires its dedicated step-up purpose", async () => {
  const calls = []; const stepUpCalls = [];
  const app = createHttp({ auth: adminAuth, service: { authorizeRefund: async (input) => { calls.push(input); return { operationId: "op-refund", status: "PENDING", duplicate: false }; } }, stepUpCalls });
  const response = await request(app, `/transactions/${transactionId}/escrow/refund`, { body: { reasonCode: "ADMIN_RESOLVED_REFUND" } });
  assert.equal(response.status, 202); assert.deepEqual(stepUpCalls, ["ESCROW_REFUND"]); assert.equal(calls[0].auth.role, "ADMIN");
});
