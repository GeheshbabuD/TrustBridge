import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createAiRouter } from "../../src/routes/ai.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { ApiError } from "../../src/utils/ApiError.js";
import { MemoryRateLimitStore } from "../../src/services/rate-limit-store.service.js";

const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const appFactory = ({ aiService, limiter = (_request, _response, next) => next(), recentMfa = (_request, _response, next) => next() } = {}) => {
  const app = express(); app.use(express.json());
  app.use("/api/v1", createAiRouter({ aiService, aiRateLimiter: limiter, recentMfaMiddleware: recentMfa, authenticationMiddleware: (request, _response, next) => {
    const role = request.get("x-test-role"); if (!role) return next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
    request.auth = { userId: role === "ADMIN" ? adminId : "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role, authVersion: 2, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() }; request.requestId = "req-ai"; return next();
  } }));
  app.use(errorHandler); return app;
};
const send = async (app, { role = "ADMIN", body = {}, id = transactionId } = {}) => {
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/transactions/${id}/risk-assessments`, { method: "POST", headers: { "x-test-role": role, "content-type": "application/json" }, body: JSON.stringify(body) }); }
  finally { server.close(); await once(server, "close"); }
};

test("risk assessment endpoint delegates only after authentication, ADMIN RBAC, recent MFA and rate limit", async () => {
  const calls = []; const order = [];
  const app = appFactory({ aiService: { assessTransactionRisk: async (input) => { calls.push(input); return { id: "assessment", status: "PENDING", result: { advisoryOnly: true } }; } },
    limiter: (_req, _res, next) => { order.push("limit"); next(); }, recentMfa: (_req, _res, next) => { order.push("mfa"); next(); } });
  const response = await send(app);
  assert.equal(response.status, 201); assert.deepEqual(order, ["limit", "mfa"]); assert.equal(calls[0].transactionId, transactionId); assert.equal(calls[0].auth.role, "ADMIN");
  const user = await send(app, { role: "USER" }); assert.equal(user.status, 403); assert.equal(calls.length, 1);
});

test("assessment endpoint rejects client-controlled fields and malformed transaction IDs", async () => {
  const app = appFactory({ aiService: { assessTransactionRisk: async () => ({}) } });
  const unauthenticated = await send(app, { role: "" }); assert.equal(unauthenticated.status, 401);
  assert.equal((await send(app, { body: { amountMinor: "1", recommendation: "RELEASE" } })).status, 400);
  assert.equal((await send(app, { id: "not-a-uuid" })).status, 400);
});

test("assessment endpoint applies its own shared rate-limit bucket", async () => {
  let calls = 0;
  const environment = { nodeEnv: "test", integrations: { ai: { enabled: false, rateLimit: { windowMs: 60000, max: 1 } } }, rateLimit: { windowMs: 60000, max: 10, keySecret: "synthetic-ai-rate-limit-key" } };
  const app = express(); app.use(express.json());
  app.use("/api/v1", createAiRouter({ environment, rateLimitStore: new MemoryRateLimitStore(), aiService: { assessTransactionRisk: async () => { calls += 1; return { id: "assessment" }; } }, recentMfaMiddleware: (_req, _res, next) => next(), authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "ADMIN", authVersion: 0 }; next(); } })); app.use(errorHandler);
  assert.equal((await send(app)).status, 201); assert.equal((await send(app)).status, 429); assert.equal(calls, 1);
});

test("missing recent MFA or rate-limit allowance fails before AI inference", async () => {
  let calls = 0; const aiService = { assessTransactionRisk: async () => { calls += 1; return {}; } };
  const blockedMfa = appFactory({ aiService, recentMfa: (_req, _res, next) => next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required")) });
  assert.equal((await send(blockedMfa)).status, 403);
  const blockedLimit = appFactory({ aiService, limiter: (_req, _res, next) => next(new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many requests")) });
  assert.equal((await send(blockedLimit)).status, 429); assert.equal(calls, 0);
});
