import assert from "node:assert/strict";
import test from "node:test";
import { createMarketplaceQueryService } from "../../src/services/marketplace-query.service.js";

const admin = { userId: "11111111-1111-4111-8111-111111111111", role: "ADMIN", status: "ACTIVE" };
const transactionRow = {
  id: "22222222-2222-4222-8222-222222222222", buyerId: "33333333-3333-4333-8333-333333333333", sellerId: "44444444-4444-4444-8444-444444444444",
  status: "CREATED", amountMinor: 9007199254740993n, currency: "INR ", version: 1, createdAt: new Date("2026-11-12T00:00:00Z"), updatedAt: new Date("2026-11-12T00:00:00Z"),
  terms: { private: "do not return" }, paymentAttempts: [{ providerReference: "private" }],
};
const disputeRow = {
  id: "55555555-5555-4555-8555-555555555555", transactionId: transactionRow.id, openedById: transactionRow.buyerId,
  status: "OPEN", category: "DELIVERY", createdAt: new Date("2026-11-12T00:00:00Z"), updatedAt: new Date("2026-11-12T00:00:00Z"),
  resolvedAt: null, closedAt: null, evidenceDeadlineAt: null, responseDeadlineAt: null, version: 1,
  description: "private evidence detail", resolution: "private resolution", evidence: [{ storageKey: "secret" }],
};

test("seller lookup uses active USER profiles and returns only public id/displayName with cursor metadata", async () => {
  let args;
  const service = createMarketplaceQueryService({ getClient: async () => ({ user: { findMany: async (input) => { args = input; return [{ id: "seller-1", profile: { displayName: "Ada" } }, { id: "seller-2", profile: { displayName: "Ada Lovelace" } }, { id: "seller-3", profile: { displayName: "Ada Seller" } }]; } } }) });
  const result = await service.searchSellers({ q: "Ada", limit: 2 });
  assert.deepEqual(result, { sellers: [{ id: "seller-1", displayName: "Ada" }, { id: "seller-2", displayName: "Ada Lovelace" }], nextCursor: "seller-2" });
  assert.deepEqual(args.where, { role: "USER", status: "ACTIVE", profile: { is: { displayName: { contains: "Ada", mode: "insensitive" } } } });
  assert.deepEqual(args.select, { id: true, profile: { select: { displayName: true } } });
});

test("admin transaction list requires admin and serializes BigInt without private terms or payment fields", async () => {
  let args;
  const service = createMarketplaceQueryService({ getClient: async () => ({ transaction: { findMany: async (input) => { args = input; return [transactionRow]; } } }) });
  await assert.rejects(service.listAdminTransactions({ auth: { ...admin, role: "USER" }, limit: 10 }), { statusCode: 403 });
  const result = await service.listAdminTransactions({ auth: admin, limit: 10, status: "CREATED", buyerId: transactionRow.buyerId });
  assert.equal(args.where.status, "CREATED");
  assert.equal(args.where.buyerId, transactionRow.buyerId);
  assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(result.transactions[0].amountMinor, "9007199254740993");
  assert.equal(result.transactions[0].currency, "INR");
  assert.equal("terms" in result.transactions[0], false);
  assert.equal("paymentAttempts" in result.transactions[0], false);
});

test("admin dispute list filters and excludes descriptions, evidence and resolution content", async () => {
  let args;
  const service = createMarketplaceQueryService({ getClient: async () => ({ dispute: { findMany: async (input) => { args = input; return [disputeRow]; } } }) });
  const result = await service.listAdminDisputes({ auth: admin, limit: 25, status: "OPEN" });
  assert.deepEqual(args.where, { status: "OPEN" });
  assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.equal(result.disputes.length, 1);
  for (const field of ["description", "resolution", "evidence", "storageKey"]) assert.equal(field in result.disputes[0], false);
});

test("empty query results stay empty and admin pagination returns a deterministic next cursor", async () => {
  const extraTransaction = { ...transactionRow, id: "66666666-6666-4666-8666-666666666666" };
  let transactionArgs;
  const service = createMarketplaceQueryService({ getClient: async () => ({
    user: { findMany: async () => [] },
    transaction: { findMany: async (args) => { transactionArgs = args; return [transactionRow, extraTransaction]; } },
    dispute: { findMany: async () => [] },
  }) });
  assert.deepEqual(await service.searchSellers({ q: "nobody", limit: 10 }), { sellers: [], nextCursor: null });
  assert.deepEqual(await service.listAdminDisputes({ auth: admin, limit: 10 }), { disputes: [], nextCursor: null });
  const page = await service.listAdminTransactions({ auth: admin, limit: 1 });
  assert.equal(transactionArgs.take, 2);
  assert.equal(page.transactions.length, 1);
  assert.equal(page.nextCursor, transactionRow.id);
});
