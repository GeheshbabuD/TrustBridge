import test from "node:test";
import assert from "node:assert/strict";
import { createDisputeService } from "../../src/services/dispute.service.js";

const activeNow = new Date("2026-11-06T12:00:00Z");
const buyerId = "buyer-1"; const sellerId = "seller-1"; const adminId = "admin-1"; const transactionId = "transaction-1"; const disputeId = "dispute-1";
const makeFixture = () => {
  const transaction = { id: transactionId, buyerId, sellerId, status: "DELIVERED", version: 3, currency: "INR" };
  const users = new Map([[buyerId, { id: buyerId, role: "USER", status: "ACTIVE", authVersion: 0 }], [sellerId, { id: sellerId, role: "USER", status: "ACTIVE", authVersion: 0 }], [adminId, { id: adminId, role: "ADMIN", status: "ACTIVE", authVersion: 0 }]]);
  const members = new Map([[buyerId, "BUYER"], [sellerId, "SELLER"]]); const disputes = new Map(); const idempotency = new Map(); const activities = []; const evidence = []; const audits = [];
  let escrow = { status: "FUNDED", balanceMinor: 9000n };
  let sequence = 0;
  const tx = {
    async $queryRaw() { return []; },
    user: { findUnique: async ({ where }) => users.get(where.id) ?? null },
    transaction: {
      findUnique: async () => ({ ...transaction }),
      updateMany: async ({ where, data }) => { if (transaction.status !== where.status || transaction.version !== where.version) return { count: 0 }; transaction.status = data.status; transaction.version += 1; return { count: 1 }; },
    },
    transactionParticipant: { findUnique: async ({ where }) => { const role = members.get(where.transactionId_userId.userId); return role ? { role } : null; } },
    escrow: { findUnique: async () => ({ ...escrow }) },
    dispute: {
      findFirst: async ({ where }) => [...disputes.values()].find((row) => row.transactionId === where.transactionId && ["OPEN", "UNDER_REVIEW"].includes(row.status)) ?? null,
      findUnique: async ({ where }) => { const row = disputes.get(where.id); return row ? { ...row } : null; },
      create: async ({ data }) => { const row = { id: disputeId, version: 1, createdAt: activeNow, updatedAt: activeNow, ...data }; disputes.set(row.id, row); return row; },
      updateMany: async ({ where, data }) => { const row = disputes.get(where.id); if (!row || (where.version !== undefined && row.version !== where.version) || (where.status && row.status !== where.status)) return { count: 0 }; const patch = { ...data }; if (patch.version?.increment) { row.version += patch.version.increment; delete patch.version; } Object.assign(row, patch); return { count: 1 }; },
    },
    disputeActivity: { create: async ({ data }) => { const row = { id: `activity-${++sequence}`, createdAt: activeNow, ...data }; activities.push(row); return row; } },
    idempotencyOperation: {
      findUnique: async ({ where }) => idempotency.get(`${where.operationScope_idempotencyKey.operationScope}|${where.operationScope_idempotencyKey.idempotencyKey}`) ?? null,
      create: async ({ data }) => { const row = { id: `idem-${sequence + 1}`, ...data }; idempotency.set(`${data.operationScope}|${data.idempotencyKey}`, row); return row; },
      update: async ({ where, data }) => { const row = idempotency.get(`${where.operationScope_idempotencyKey.operationScope}|${where.operationScope_idempotencyKey.idempotencyKey}`); Object.assign(row, data); return row; },
    },
    transactionStatusHistory: { create: async ({ data }) => data },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: `audit-${audits.length}` }; } },
    evidence: { create: async ({ data }) => { const row = { id: `evidence-${evidence.length + 1}`, createdAt: activeNow, ...data }; evidence.push(row); return row; }, findUnique: async ({ where }) => { const row = evidence.find((entry) => entry.id === where.id); return row ? { ...row, dispute: { ...disputes.get(row.disputeId), transaction: { ...transaction } } } : null; } },
    async $transaction(callback) { return callback(this); },
  };
  const storageObjects = new Map();
  const storage = {
    async putObject({ key, body }) { storageObjects.set(key, Buffer.from(body)); },
    async getObject({ key }) { return storageObjects.get(key); },
    async deleteObject({ key }) { storageObjects.delete(key); },
  };
  const service = createDisputeService({ getClient: async () => tx, storage, now: () => activeNow, fingerprintSecret: "test-fingerprint-key" });
  return { service, tx, transaction, users, members, disputes, idempotency, activities, evidence, audits, storageObjects, setEscrow(value) { escrow = value; } };
};
const userAuth = (userId) => ({ userId, role: "USER", status: "ACTIVE", authVersion: 0 });
const adminAuth = () => ({ userId: adminId, role: "ADMIN", status: "ACTIVE", authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: activeNow });
const opened = { category: "QUALITY", description: "The delivered item differs from the agreed terms." };

test("participant dispute creation is idempotent and atomically marks the transaction disputed", async () => {
  const f = makeFixture();
  const first = await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-001" });
  const retry = await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-001" });
  assert.equal(first.dispute.status, "OPEN"); assert.equal(first.duplicate, false);
  assert.equal(retry.dispute.id, disputeId); assert.equal(retry.duplicate, true);
  assert.equal(f.transaction.status, "DISPUTED"); assert.equal(f.transaction.version, 4);
  assert.equal(f.activities[0].type, "OPENED"); assert.equal(f.audits[0].action, "DISPUTE_OPENED");
  assert.ok(f.disputes.get(disputeId).evidenceDeadlineAt > activeNow);
  await assert.rejects(f.service.create({ auth: userAuth(sellerId), transactionId, input: opened, idempotencyKey: "dispute-create-002" }), (error) => error.statusCode === 409);
});

test("ADMIN has no transaction-ownership bypass for opening or reading participant disputes", async () => {
  const f = makeFixture();
  await assert.rejects(f.service.create({ auth: { ...adminAuth(), role: "ADMIN" }, transactionId, input: opened, idempotencyKey: "dispute-admin-001" }));
  await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-003" });
  await assert.rejects(f.service.get({ auth: userAuth("unrelated"), disputeId }));
});

test("responses are participant-only and append a chronological activity record", async () => {
  const f = makeFixture(); await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-004" });
  const response = await f.service.respond({ auth: userAuth(sellerId), disputeId, message: "I can provide the agreed delivery record." });
  assert.equal(response.sequence, 2); assert.equal(f.activities[1].type, "RESPONSE");
  await assert.rejects(f.service.respond({ auth: userAuth("outsider"), disputeId, message: "No access" }));
});

test("evidence upload validates file signature, stores bytes privately and persists metadata only", async () => {
  const f = makeFixture(); await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-005" });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const result = await f.service.uploadEvidence({ auth: userAuth(sellerId), disputeId, body: png, contentType: "image/png", filename: "..\\private\\proof.png", category: "DELIVERY" });
  assert.equal(result.contentType, "image/png"); assert.equal(f.evidence[0].sizeBytes, BigInt(png.length));
  assert.equal(f.evidence[0].storageObjectKey.includes("proof"), false);
  assert.equal(f.evidence[0].sha256Hash.length, 64); assert.equal(f.storageObjects.size, 1);
  const file = await f.service.downloadEvidence({ auth: userAuth(buyerId), evidenceId: result.id });
  assert.deepEqual(file.body, png); assert.equal(file.contentType, "image/png");
  await assert.rejects(f.service.uploadEvidence({ auth: userAuth(buyerId), disputeId, body: Buffer.from("<html>"), contentType: "image/png", category: "OTHER" }), (error) => error.code === "EVIDENCE_INVALID");
  await assert.rejects(f.service.uploadEvidence({ auth: userAuth(buyerId), disputeId, body: png, contentType: "image/png", category: "../private" }), (error) => error.code === "EVIDENCE_INVALID");
  assert.equal(f.evidence.length, 1);
  await assert.rejects(f.service.downloadEvidence({ auth: userAuth("outsider"), evidenceId: result.id }));
});

test("dispute resolution requires TOTP, ADMIN identity and valid partial amount", async () => {
  const f = makeFixture(); await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-006" });
  await f.service.startReview({ auth: adminAuth(), disputeId });
  await assert.rejects(f.service.resolve({ auth: { ...adminAuth(), assuranceLevel: "RECOVERY_CODE_VERIFIED" }, disputeId, outcome: "FULL_REFUND", reason: "Evidence establishes full non-delivery." }));
  await assert.rejects(f.service.resolve({ auth: adminAuth(), disputeId, outcome: "PARTIAL_REFUND", amountMinor: "9000", reason: "A proportional refund is approved." }), (error) => error.code === "PARTIAL_REFUND_AMOUNT_INVALID");
  const result = await f.service.resolve({ auth: adminAuth(), disputeId, outcome: "PARTIAL_REFUND", amountMinor: "2500", reason: "Evidence supports partial compensation." });
  assert.equal(result.resolution, "PARTIAL_REFUND"); assert.equal(result.resolutionAmountMinor, "2500");
  assert.equal(f.transaction.status, "DISPUTED");
  assert.equal(f.audits.at(-1).metadata.outcome, "PARTIAL_REFUND");
});

test("seller-release resolution moves only the transaction eligibility state; it does not move funds", async () => {
  const f = makeFixture(); await f.service.create({ auth: userAuth(buyerId), transactionId, input: opened, idempotencyKey: "dispute-create-007" });
  await f.service.startReview({ auth: adminAuth(), disputeId });
  const result = await f.service.resolve({ auth: adminAuth(), disputeId, outcome: "SELLER_RELEASE", reason: "Evidence supports seller completion." });
  assert.equal(result.transactionStatus, "DELIVERED");
  assert.equal(f.disputes.get(disputeId).resolution, "SELLER_RELEASE");
  assert.equal(f.activities.at(-1).type, "RESOLVED");
});
