import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createDisputeRouter } from "../../src/routes/dispute.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { ApiError } from "../../src/utils/ApiError.js";

const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disputeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const evidenceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const buyerId = "11111111-1111-4111-8111-111111111111";
const sellerId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";
const appFactory = ({ methods = {}, stepUps = [], oneTimeStepUps = false, grantState = { consumptions: 0 } } = {}) => {
  const app = express(); app.use(express.json());
  const userId = { BUYER: buyerId, SELLER: sellerId, ADMIN: adminId, OUTSIDER: "44444444-4444-4444-8444-444444444444" };
  const getClient = async () => ({
    transaction: { findUnique: async () => ({ id: transactionId, buyerId, sellerId }) },
    transactionParticipant: { findUnique: async ({ where }) => where.transactionId_userId.userId === buyerId ? { role: "BUYER" } : where.transactionId_userId.userId === sellerId ? { role: "SELLER" } : null },
    dispute: { findUnique: async () => ({ id: disputeId, transaction: { id: transactionId, buyerId, sellerId } }) },
    evidence: { findUnique: async () => ({ id: evidenceId, dispute: { transaction: { id: transactionId, buyerId, sellerId } } }) },
  });
  const service = Object.fromEntries(["create", "get", "respond", "uploadEvidence", "downloadEvidence", "startReview", "resolve"].map((method) => [method, methods[method] ?? (async () => ({}))]));
  app.use("/api/v1", createDisputeRouter({ disputeService: service, getClient,
    authenticationMiddleware: (request, _response, next) => { const type = request.get("x-test-user"); if (!type) return next(Object.assign(new Error("auth required"), { statusCode: 401, code: "AUTHENTICATION_REQUIRED" })); request.auth = { userId: userId[type], role: type === "ADMIN" ? "ADMIN" : "USER", status: "ACTIVE", authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() }; request.requestId = "req-dispute"; next(); },
    stepUpAuthorizationMiddlewareFactory: ({ purpose }) => (_request, response, next) => {
      stepUps.push(purpose);
      if (oneTimeStepUps && grantState.consumed?.has(purpose)) return next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required"));
      if (oneTimeStepUps) {
        grantState.consumed ??= new Set();
        grantState.consumed.add(purpose);
        grantState.consumptions += 1;
      }
      return next();
    },
  }));
  app.use(errorHandler); return app;
};
const request = async (app, path, { method = "GET", role = "BUYER", body, headers = {} } = {}) => {
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, { method, headers: { "x-test-user": role, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  finally { server.close(); await once(server, "close"); }
};

test("HTTP dispute create requires participant identity, idempotency header and strict body", async () => {
  const calls = []; const app = appFactory({ methods: { create: async (input) => { calls.push(input); return { dispute: { id: disputeId, status: "OPEN" }, duplicate: false }; } } });
  const response = await request(app, `/transactions/${transactionId}/disputes`, { method: "POST", body: { category: "QUALITY", description: "The delivered goods do not match the terms." }, headers: { "content-type": "application/json", "idempotency-key": "dispute-http-key-1" } });
  assert.equal(response.status, 201); assert.equal((await response.json()).data.id, disputeId);
  assert.equal(calls[0].auth.userId, buyerId); assert.equal(calls[0].idempotencyKey, "dispute-http-key-1");
  const admin = await request(app, `/transactions/${transactionId}/disputes`, { method: "POST", role: "ADMIN", body: { category: "QUALITY", description: "The delivered goods do not match the terms." }, headers: { "content-type": "application/json", "idempotency-key": "dispute-http-key-2" } });
  assert.equal(admin.status, 404);
  const invalid = await request(app, `/transactions/${transactionId}/disputes`, { method: "POST", body: { ...{ category: "QUALITY", description: "A sufficiently long dispute description." }, status: "RESOLVED" }, headers: { "content-type": "application/json", "idempotency-key": "dispute-http-key-3" } });
  assert.equal(invalid.status, 400);
});

test("HTTP review and resolution require their separate registered TOTP step-up purposes", async () => {
  const stepUps = []; const app = appFactory({ stepUps, methods: { startReview: async () => ({ status: "UNDER_REVIEW" }), resolve: async ({ outcome }) => ({ status: "RESOLVED", outcome }) } });
  const review = await request(app, `/admin/disputes/${disputeId}/review`, { method: "POST", role: "ADMIN", body: {} });
  assert.equal(review.status, 200); assert.deepEqual(stepUps, ["DISPUTE_REVIEW"]);
  const resolution = await request(app, `/admin/disputes/${disputeId}/resolve`, { method: "POST", role: "ADMIN", body: { outcome: "PARTIAL_REFUND", amountMinor: "2500", reason: "Evidence supports a proportional refund." } });
  assert.equal(resolution.status, 200); assert.deepEqual(stepUps, ["DISPUTE_REVIEW", "DISPUTE_RESOLUTION"]);
  const amountTamper = await request(app, `/admin/disputes/${disputeId}/resolve`, { method: "POST", role: "ADMIN", body: { outcome: "PARTIAL_REFUND", amountMinor: 2500, reason: "Evidence supports a proportional refund." } });
  assert.equal(amountTamper.status, 400);
});

test("invalid dispute step-up requests do not consume grants; valid resolution consumes once and replay is denied", async () => {
  const stepUps = []; const grantState = { consumptions: 0 }; let resolutions = 0;
  const app = appFactory({ stepUps, grantState, oneTimeStepUps: true, methods: { resolve: async ({ outcome }) => { resolutions += 1; return { status: "RESOLVED", outcome }; } } });
  const invalidPath = await request(app, "/admin/disputes/not-a-uuid/review", { method: "POST", role: "ADMIN", body: {} });
  assert.equal(invalidPath.status, 400);
  const invalidBody = await request(app, `/admin/disputes/${disputeId}/resolve`, { method: "POST", role: "ADMIN", body: { outcome: "PARTIAL_REFUND", amountMinor: 1, reason: "Bad amount type." } });
  assert.equal(invalidBody.status, 400);
  assert.equal(grantState.consumptions, 0);
  assert.deepEqual(stepUps, []);
  assert.equal(resolutions, 0);

  const validBody = { outcome: "PARTIAL_REFUND", amountMinor: "2500", reason: "Evidence supports a proportional refund." };
  const first = await request(app, `/admin/disputes/${disputeId}/resolve`, { method: "POST", role: "ADMIN", body: validBody });
  assert.equal(first.status, 200);
  assert.equal(grantState.consumptions, 1);
  const replay = await request(app, `/admin/disputes/${disputeId}/resolve`, { method: "POST", role: "ADMIN", body: validBody });
  assert.equal(replay.status, 403);
  assert.equal(grantState.consumptions, 1);
  assert.equal(resolutions, 1);
});

test("HTTP evidence upload uses bounded raw bytes, checks MIME and returns no storage reference", async () => {
  const calls = []; const app = appFactory({ methods: { uploadEvidence: async (input) => { calls.push(input); return { id: evidenceId, contentType: input.contentType, sizeBytes: String(input.body.length) }; } } });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/disputes/${disputeId}/evidence`, { method: "POST", headers: { "x-test-user": "SELLER", "content-type": "image/png", "x-evidence-category": "DELIVERY", "x-evidence-filename": "proof.png" }, body: png });
    assert.equal(response.status, 201); const body = await response.json(); assert.equal(body.data.id, evidenceId); assert.equal("storageObjectKey" in body.data, false); assert.deepEqual(calls[0].body, png);
    const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/disputes/${disputeId}/evidence`, { method: "POST", headers: { "x-test-user": "SELLER", "content-type": "text/plain", "x-evidence-category": "OTHER" }, body: "not evidence" });
    assert.equal(denied.status, 400);
  } finally { server.close(); await once(server, "close"); }
});

test("evidence reads use dispute/transaction participation while admin review is an explicit step-up path", async () => {
  const stepUps = []; const app = appFactory({ stepUps, methods: { downloadEvidence: async ({ adminReview }) => ({ body: Buffer.from("private"), contentType: "application/pdf", filename: "proof.pdf", adminReview }) } });
  const participant = await request(app, `/dispute-evidence/${evidenceId}`);
  assert.equal(participant.status, 200); assert.equal(participant.headers.get("cache-control"), "private, no-store");
  const outsider = await request(app, `/dispute-evidence/${evidenceId}`, { role: "OUTSIDER" }); assert.equal(outsider.status, 404);
  const admin = await request(app, `/admin/dispute-evidence/${evidenceId}`, { role: "ADMIN" }); assert.equal(admin.status, 200); assert.deepEqual(stepUps, ["DISPUTE_REVIEW"]);
});
