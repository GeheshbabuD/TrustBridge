import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createAuthRouter } from "../../src/routes/auth.routes.js";
import { createDisputeRouter } from "../../src/routes/dispute.routes.js";
import { createAiRouter } from "../../src/routes/ai.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { ApiError } from "../../src/utils/ApiError.js";

const adminId = "33333333-3333-4333-8333-333333333333";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disputeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const oneTimeStepUpFactory = (state) => ({ purpose }) => (_request, _response, next) => {
  if (state.consumed.has(purpose)) return next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required"));
  state.consumed.add(purpose);
  state.consumptions += 1;
  return next();
};

const listen = async (app, run) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { const closed = once(server, "close"); server.close(); await closed; }
};

const postJson = (base, path, body) => fetch(`${base}/api/v1${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const get = (base, path) => fetch(`${base}/api/v1${path}`);

test("legacy ADMIN recovery validates path and body before one-time step-up; valid operation consumes once", async () => {
  const grantState = { consumed: new Set(), consumptions: 0 };
  let operations = 0;
  const environment = {
    nodeEnv: "test",
    rateLimit: { keySecret: "test-only-key-secret", windowMs: 60_000, max: 100 },
    mfa: {
      loginRateLimit: { windowMs: 60_000, max: 100 },
      verificationRateLimit: { windowMs: 60_000, max: 100 },
      challengeRateLimit: { windowMs: 60_000, max: 100 },
    },
  };
  const noop = (_request, _response, next) => next();
  const mfaService = {
    issueLegacyAdminEnrollmentAuthorization: async () => { operations += 1; return { issued: true, expiresAt: new Date().toISOString() }; },
    verifyLegacyAdminRecoveryIdentity: async () => { operations += 1; },
    approveLegacyAdminRecovery: async () => { operations += 1; return { recorded: true }; },
  };
  const app = express(); app.use(express.json());
  app.use("/api/v1/auth", createAuthRouter({
    environment, mfaService, authService: {}, sessionService: {},
    authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "ADMIN" }; next(); },
    mfaRecoveryMutationRateLimiter: noop,
    authLoginRateLimiter: noop,
    authRegistrationRateLimiter: noop,
    mfaChallengeRateLimiter: noop,
    mfaStepUpCreateRateLimiter: noop,
    mfaStepUpVerifyRateLimiter: noop,
    mfaVerificationRateLimiter: noop,
    stepUpAuthorizationMiddlewareFactory: oneTimeStepUpFactory(grantState),
  }));
  app.use(errorHandler);

  await listen(app, async (base) => {
    const invalidId = await postJson(base, "/auth/mfa/admin-enrollment/requests/not-a-uuid/identity", { evidenceReference: "verified-case-123" });
    assert.equal(invalidId.status, 400);
    const invalidBody = await postJson(base, `/auth/mfa/admin-enrollment/requests/${requestId}/identity`, { evidenceReference: "" });
    assert.equal(invalidBody.status, 400);
    const unknownField = await postJson(base, `/auth/mfa/admin-enrollment/requests/${requestId}/approval`, { decision: "APPROVE", isAdmin: true });
    assert.equal(unknownField.status, 400);
    assert.equal(grantState.consumptions, 0);
    assert.equal(operations, 0);

    const valid = await postJson(base, `/auth/mfa/admin-enrollment/requests/${requestId}/identity`, { evidenceReference: "verified-case-123" });
    assert.equal(valid.status, 200);
    assert.equal(grantState.consumptions, 1);
    const replay = await postJson(base, `/auth/mfa/admin-enrollment/requests/${requestId}/identity`, { evidenceReference: "verified-case-123" });
    assert.equal(replay.status, 403);
    assert.equal(grantState.consumptions, 1);
    assert.equal(operations, 1);
  });
});

test("dispute review and resolution reject invalid input before one-time step-up", async () => {
  const grantState = { consumed: new Set(), consumptions: 0 };
  let operations = 0;
  const app = express(); app.use(express.json());
  app.use("/api/v1", createDisputeRouter({
    disputeService: {
      startReview: async () => { operations += 1; return { status: "UNDER_REVIEW" }; },
      resolve: async () => { operations += 1; return { status: "RESOLVED" }; },
    },
    authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "ADMIN", assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() }; next(); },
    stepUpAuthorizationMiddlewareFactory: oneTimeStepUpFactory(grantState),
  }));
  app.use(errorHandler);

  await listen(app, async (base) => {
    const invalidPath = await postJson(base, "/admin/disputes/not-a-uuid/review", {});
    assert.equal(invalidPath.status, 400);
    const invalidBody = await postJson(base, `/admin/disputes/${disputeId}/resolve`, { outcome: "PARTIAL_REFUND", amountMinor: 1, reason: "Wrong amount type." });
    assert.equal(invalidBody.status, 400);
    assert.equal(grantState.consumptions, 0);
    assert.equal(operations, 0);

    const valid = await postJson(base, `/admin/disputes/${disputeId}/resolve`, { outcome: "FULL_REFUND", reason: "The evidence supports a full refund." });
    assert.equal(valid.status, 200);
    assert.equal(grantState.consumptions, 1);
    assert.equal(operations, 1);
  });
});

test("MFA regeneration and disable validate empty bodies before their purpose-bound one-time grants", async () => {
  const grantState = { consumed: new Set(), consumptions: 0 };
  let operations = 0;
  const environment = {
    nodeEnv: "test", rateLimit: { keySecret: "test-only-key-secret", windowMs: 60_000, max: 100 },
    mfa: { loginRateLimit: { windowMs: 60_000, max: 100 }, verificationRateLimit: { windowMs: 60_000, max: 100 }, challengeRateLimit: { windowMs: 60_000, max: 100 } },
  };
  const noop = (_request, _response, next) => next();
  const app = express(); app.use(express.json());
  app.use("/api/v1/auth", createAuthRouter({
    environment, authService: {}, sessionService: {},
    authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "USER" }; next(); },
    mfaRecoveryMutationRateLimiter: noop, authLoginRateLimiter: noop, authRegistrationRateLimiter: noop,
    mfaChallengeRateLimiter: noop, mfaStepUpCreateRateLimiter: noop, mfaStepUpVerifyRateLimiter: noop, mfaVerificationRateLimiter: noop,
    stepUpAuthorizationMiddlewareFactory: oneTimeStepUpFactory(grantState),
    mfaService: {
      regenerateRecoveryCodes: async () => { operations += 1; return { codes: ["one-time"] }; },
      disableMfa: async () => { operations += 1; return { disabled: true }; },
    },
  })); app.use(errorHandler);

  await listen(app, async (base) => {
    const regenerate = "/auth/mfa/recovery-codes/regenerate";
    const disable = "/auth/mfa/disable";
    assert.equal((await postJson(base, regenerate, { unexpected: true })).status, 400);
    assert.equal((await postJson(base, disable, { unexpected: true })).status, 400);
    assert.equal(grantState.consumptions, 0);
    assert.equal(operations, 0);

    assert.equal((await postJson(base, regenerate, {})).status, 200);
    assert.equal(grantState.consumptions, 1);
    assert.equal((await postJson(base, regenerate, {})).status, 403);
    assert.equal(grantState.consumptions, 1);
    assert.equal((await postJson(base, disable, {})).status, 200);
    assert.equal(grantState.consumptions, 2);
    assert.equal((await postJson(base, disable, {})).status, 403);
    assert.equal(grantState.consumptions, 2);
    assert.equal(operations, 2);
  });
});

test("admin dispute detail validates the resource before consuming the review grant", async () => {
  const grantState = { consumed: new Set(), consumptions: 0 };
  let reads = 0;
  const app = express(); app.use(express.json());
  app.use("/api/v1", createDisputeRouter({
    disputeService: { get: async () => { reads += 1; return { id: disputeId }; } },
    authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "ADMIN" }; next(); },
    stepUpAuthorizationMiddlewareFactory: oneTimeStepUpFactory(grantState),
  })); app.use(errorHandler);

  await listen(app, async (base) => {
    assert.equal((await get(base, "/admin/disputes/not-a-uuid")).status, 400);
    assert.equal(grantState.consumptions, 0);
    assert.equal(reads, 0);
    assert.equal((await get(base, `/admin/disputes/${disputeId}`)).status, 200);
    assert.equal(grantState.consumptions, 1);
    assert.equal((await get(base, `/admin/disputes/${disputeId}`)).status, 403);
    assert.equal(grantState.consumptions, 1);
    assert.equal(reads, 1);
  });
});

test("AI dispute assistance validates path and strict empty body before consuming its review grant", async () => {
  const grantState = { consumed: new Set(), consumptions: 0 };
  let assessments = 0;
  const app = express(); app.use(express.json());
  app.use("/api/v1", createAiRouter({
    aiDisputeService: { assessDispute: async () => { assessments += 1; return { advisoryOnly: true }; } },
    disputeAssistanceRateLimiter: (_request, _response, next) => next(),
    authenticationMiddleware: (request, _response, next) => { request.auth = { userId: adminId, role: "ADMIN" }; next(); },
    disputeAssistanceStepUpMiddleware: oneTimeStepUpFactory(grantState)({ purpose: "DISPUTE_REVIEW" }),
  })); app.use(errorHandler);

  await listen(app, async (base) => {
    assert.equal((await postJson(base, "/admin/disputes/not-a-uuid/assistance", {})).status, 400);
    assert.equal((await postJson(base, `/admin/disputes/${disputeId}/assistance`, { internal: true })).status, 400);
    assert.equal(grantState.consumptions, 0);
    assert.equal(assessments, 0);
    assert.equal((await postJson(base, `/admin/disputes/${disputeId}/assistance`, {})).status, 201);
    assert.equal(grantState.consumptions, 1);
    assert.equal((await postJson(base, `/admin/disputes/${disputeId}/assistance`, {})).status, 403);
    assert.equal(grantState.consumptions, 1);
    assert.equal(assessments, 1);
  });
});
