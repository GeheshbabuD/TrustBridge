import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createAiRouter } from "../../src/routes/ai.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { ApiError } from "../../src/utils/ApiError.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const appFor = ({ service, limiter = (_req, _res, next) => next(), mfa = (_req, _res, next) => next() } = {}) => {
  const app = express(); app.use(express.json());
  app.use("/api/v1", createAiRouter({ riskBaselineService: service, riskBaselineRateLimiter: limiter, recentMfaMiddleware: mfa, authenticationMiddleware: (req, _res, next) => {
    const role = req.get("x-test-role"); if (!role) return next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
    req.auth = { userId: "admin-id", role, authVersion: 2 }; req.requestId = "test-request"; return next();
  } })); app.use(errorHandler); return app;
};
const send = async (app, { role = "ADMIN", body = {}, transactionId = id } = {}) => {
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/transactions/${transactionId}/risk-baselines`, { method: "POST", headers: { "x-test-role": role, "content-type": "application/json" }, body: JSON.stringify(body) }); }
  finally { server.close(); await once(server, "close"); }
};

test("baseline endpoint composes shared limit, ADMIN role and recent TOTP gate before service", async () => {
  const order = []; const calls = [];
  const app = appFor({ service: { assessTransactionRisk: async (args) => { calls.push(args); return { id: "assessment", riskLevel: "LOW" }; } }, limiter: (_req, _res, next) => { order.push("limit"); next(); }, mfa: (_req, _res, next) => { order.push("mfa"); next(); } });
  const response = await send(app);
  assert.equal(response.status, 201); assert.deepEqual(order, ["limit", "mfa"]); assert.equal(calls.length, 1); assert.equal(calls[0].transactionId, id);
  assert.equal((await send(app, { role: "USER" })).status, 403); assert.equal(calls.length, 1);
});

test("baseline endpoint rejects unauthenticated, malformed and client-controlled data without disclosing assessments", async () => {
  let calls = 0;
  const app = appFor({ service: { assessTransactionRisk: async () => { calls += 1; return {}; } } });
  assert.equal((await send(app, { role: "" })).status, 401);
  assert.equal((await send(app, { body: { amountMinor: "1", role: "ADMIN", recommendation: "RELEASE" } })).status, 400);
  assert.equal((await send(app, { transactionId: "bad-id" })).status, 400);
  assert.equal(calls, 0);
});

test("missing recent TOTP and rate-limit allowance prevent baseline access", async () => {
  let calls = 0; const service = { assessTransactionRisk: async () => { calls += 1; return {}; } };
  const blockedMfa = appFor({ service, mfa: (_req, _res, next) => next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required")) });
  assert.equal((await send(blockedMfa)).status, 403);
  const blockedLimit = appFor({ service, limiter: (_req, _res, next) => next(new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many requests")) });
  assert.equal((await send(blockedLimit)).status, 429); assert.equal(calls, 0);
});
