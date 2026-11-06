import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createAiRouter } from "../../src/routes/ai.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { ApiError } from "../../src/utils/ApiError.js";

const disputeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const appFor = ({ service, limit = (_req, _res, next) => next(), stepUp = (_req, _res, next) => next() } = {}) => {
  const order = [];
  const app = express(); app.use(express.json());
  app.use("/api/v1", createAiRouter({ aiDisputeService: service, disputeAssistanceRateLimiter: (req, res, next) => { order.push("limit"); limit(req, res, next); }, disputeAssistanceStepUpMiddleware: (req, res, next) => { order.push("step-up"); stepUp(req, res, next); }, authenticationMiddleware: (req, _res, next) => {
    const role = req.get("x-test-role"); if (!role) return next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
    req.auth = { userId: "admin", role, authVersion: 1 }; req.requestId = "req-dispute-ai"; return next();
  } })); app.use(errorHandler); return { app, order };
};
const send = async (app, { role = "ADMIN", body = {}, id = disputeId } = {}) => {
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/disputes/${id}/assistance`, { method: "POST", headers: { "x-test-role": role, "content-type": "application/json" }, body: JSON.stringify(body) }); }
  finally { server.close(); await once(server, "close"); }
};

test("dispute assistance is limited, ADMIN-only and step-up gated before service invocation", async () => {
  let calls = 0; const f = appFor({ service: { assessDispute: async (args) => { calls += 1; return { disputeId: args.disputeId, result: { advisoryOnly: true } }; } } });
  const response = await send(f.app);
  assert.equal(response.status, 201); assert.deepEqual(f.order, ["limit", "step-up"]); assert.equal(calls, 1);
  assert.equal((await send(f.app, { role: "USER" })).status, 403); assert.equal(calls, 1);
});

test("dispute assistance rejects unauthenticated, invalid and client-supplied assessment data", async () => {
  let calls = 0; const { app } = appFor({ service: { assessDispute: async () => { calls += 1; return {}; } } });
  assert.equal((await send(app, { role: "" })).status, 401);
  assert.equal((await send(app, { id: "not-uuid" })).status, 400);
  assert.equal((await send(app, { body: { description: "replace the claim", resolution: "FULL_REFUND", provider: "chosen" } })).status, 400);
  assert.equal(calls, 0);
});

test("dispute assistance does not proceed when shared limiting or step-up is denied", async () => {
  let calls = 0; const service = { assessDispute: async () => { calls += 1; return {}; } };
  const deniedLimit = appFor({ service, limit: (_req, _res, next) => next(new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many requests")) });
  assert.equal((await send(deniedLimit.app)).status, 429);
  const deniedStepUp = appFor({ service, stepUp: (_req, _res, next) => next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required")) });
  assert.equal((await send(deniedStepUp.app)).status, 403); assert.equal(calls, 0);
});
