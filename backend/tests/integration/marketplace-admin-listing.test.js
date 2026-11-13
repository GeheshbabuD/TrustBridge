import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { createAdminRouter } from "../../src/routes/admin.routes.js";
import { createMarketplaceRouter } from "../../src/routes/marketplace.routes.js";
import { createMarketplaceQueryService } from "../../src/services/marketplace-query.service.js";
import { ApiError } from "../../src/utils/ApiError.js";

const adminId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const withServer = async (app, run) => {
  const server = app.listen(0); await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
};

test("seller directory and administrator lists enforce auth, MFA, validation, filters and safe projections", async () => {
  const calls = [];
  const prisma = {
    user: { findMany: async (args) => { calls.push(["seller", args]); return [{ id: "seller-public-id", email: "private@example.test", passwordHash: "secret", profile: { displayName: "Public Seller" } }]; } },
    transaction: { findMany: async (args) => { calls.push(["transaction", args]); return [{ id: transactionId, buyerId: "buyer-id", sellerId: "seller-id", status: "CREATED", amountMinor: 1200n, currency: "INR", version: 2, createdAt: new Date(), updatedAt: new Date(), terms: { secret: true } }]; } },
    dispute: { findMany: async (args) => { calls.push(["dispute", args]); return [{ id: "dispute-id", transactionId, openedById: "buyer-id", status: "OPEN", category: "DELIVERY", createdAt: new Date(), updatedAt: new Date(), resolvedAt: null, closedAt: null, evidenceDeadlineAt: null, responseDeadlineAt: null, version: 1, description: "private", resolution: "private", evidence: [{ storageKey: "secret" }] }]; } },
  };
  const queryService = createMarketplaceQueryService({ getClient: async () => prisma });
  let rateLimitCalls = 0;
  const auth = (request, _response, next) => {
    const role = request.get("x-test-role");
    if (!role) return next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
    request.auth = { userId: role === "ADMIN" ? adminId : "33333333-3333-4333-8333-333333333333", role, status: "ACTIVE", authVersion: 1, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() };
    return next();
  };
  const recentMfa = (request, _response, next) => request.get("x-test-mfa") === "yes" ? next() : next(new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required"));
  const app = express();
  app.use(createMarketplaceRouter({ authenticationMiddleware: auth, marketplaceQueryService: queryService }));
  app.use(createAdminRouter({ authenticationMiddleware: auth, marketplaceQueryService: queryService, recentMfaMiddleware: recentMfa, adminReadRateLimiter: (_request, _response, next) => { rateLimitCalls += 1; next(); } }));
  app.use(errorHandler);

  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/sellers?q=Public`)).status, 401);
    const sellerResponse = await fetch(`${base}/sellers?q=Public&limit=10`, { headers: { "x-test-role": "USER" } });
    assert.equal(sellerResponse.status, 200);
    const sellerBody = await sellerResponse.json();
    assert.deepEqual(sellerBody.data.sellers, [{ id: "seller-public-id", displayName: "Public Seller" }]);
    assert.equal(JSON.stringify(sellerBody).includes("private@example.test"), false);
    assert.equal(JSON.stringify(sellerBody).includes("passwordHash"), false);

    assert.equal((await fetch(`${base}/admin/transactions`, { headers: { "x-test-role": "USER", "x-test-mfa": "yes" } })).status, 403);
    assert.equal((await fetch(`${base}/admin/transactions?limit=0`, { headers: { "x-test-role": "ADMIN", "x-test-mfa": "yes" } })).status, 400);
    assert.equal((await fetch(`${base}/admin/disputes`, { headers: { "x-test-role": "ADMIN" } })).status, 403);

    const txResponse = await fetch(`${base}/admin/transactions?status=CREATED&limit=10`, { headers: { "x-test-role": "ADMIN", "x-test-mfa": "yes" } });
    assert.equal(txResponse.status, 200);
    const txBody = await txResponse.json();
    assert.equal(txBody.data.transactions[0].amountMinor, "1200");
    assert.equal("terms" in txBody.data.transactions[0], false);

    const disputeResponse = await fetch(`${base}/admin/disputes?status=OPEN`, { headers: { "x-test-role": "ADMIN", "x-test-mfa": "yes" } });
    assert.equal(disputeResponse.status, 200);
    const disputeBody = await disputeResponse.json();
    assert.equal(disputeBody.data.disputes[0].category, "DELIVERY");
    assert.equal("description" in disputeBody.data.disputes[0], false);
    assert.equal("evidence" in disputeBody.data.disputes[0], false);
    assert.deepEqual(calls.find(([kind]) => kind === "transaction")[1].where, { status: "CREATED" });
    assert.deepEqual(calls.find(([kind]) => kind === "dispute")[1].where, { status: "OPEN" });
    assert.equal(rateLimitCalls, 3);
    const invalidSellerQuery = await fetch(`${base}/sellers?unexpected=true&q=Public`, { headers: { "x-test-role": "USER" } });
    assert.equal(invalidSellerQuery.status, 400);
    assert.deepEqual(await invalidSellerQuery.json().then(({ error, message }) => ({ error, message })), { error: { code: "VALIDATION_ERROR" }, message: "Request validation failed" });
  });
});
