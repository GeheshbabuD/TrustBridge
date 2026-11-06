import assert from "node:assert/strict";
import test from "node:test";
import { createAiService } from "../../src/services/ai.service.js";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const transactionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = new Date("2026-11-07T12:00:00Z");
const result = { score: 31, riskLevel: "MEDIUM", indicators: [{ code: "FAILED_ATTEMPT", severity: "MEDIUM", explanation: "A failed attempt was recorded." }], confidenceLevel: "LOW", recommendation: "MANUAL_REVIEW", summary: "A human may review this assessment." };
const auth = { userId: adminId, role: "ADMIN", authVersion: 3, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: time };

const fixture = ({ currentVersion = 9, failAudit = false } = {}) => {
  const persisted = []; const audits = []; const received = [];
  let txRead = 0;
  const tx = {
    $queryRaw: async () => [{ version: currentVersion }],
    user: { findUnique: async () => ({ id: adminId, role: "ADMIN", status: "ACTIVE", authVersion: 3 }) },
    transaction: { findUnique: async () => ++txRead === 1 ? { id: transactionId, status: "FUNDED", amountMinor: 75000n, currency: "INR ", createdAt: new Date("2026-11-05T12:00:00Z"), version: 9 } : { version: currentVersion } },
    paymentAttempt: { groupBy: async () => [{ status: "CAPTURED", _count: { _all: 1 } }, { status: "FAILED", _count: { _all: 2 } }] },
    dispute: { groupBy: async () => [{ status: "RESOLVED", _count: { _all: 1 } }] },
    aIAnalysis: { create: async ({ data }) => { persisted.push(data); return { id: "analysis-id", ...data, createdAt: time }; } },
    auditLog: { create: async ({ data }) => { if (failAudit) throw new Error("db failure"); audits.push(data); return { id: "audit-id" }; } },
  };
  const prisma = { ...tx, async $transaction(callback) { return callback(tx); } };
  const adapter = { provider: "gateway", modelIdentifier: "risk-v1", modelVersion: "2026-01", capabilities: { transactionRiskAssessment: true }, async assessTransactionRisk(input) { received.push(input); return { provider: "gateway", modelIdentifier: "risk-v1", modelVersion: "2026-01", result }; } };
  const service = createAiService({ getClient: async () => prisma, adapter, enabled: true, provider: "gateway", modelIdentifier: "risk-v1", modelVersion: "2026-01", now: () => time });
  return { service, persisted, audits, received };
};

test("assessment sends minimized aggregate transaction data and persists advisory provenance", async () => {
  const f = fixture(); const record = await f.service.assessTransactionRisk({ auth, transactionId, requestId: "req-ai" });
  assert.equal(f.received.length, 1);
  const serializedInput = JSON.stringify(f.received[0]);
  for (const privateField of ["buyerId", "sellerId", "email", "description", "storageObjectKey", "providerReference"]) assert.equal(serializedInput.includes(privateField), false);
  assert.deepEqual(f.received[0].paymentAttempts, { created: 0, pending: 0, captured: 1, failed: 2, cancelled: 0 });
  assert.deepEqual(f.received[0].disputes, { open: 0, underReview: 0, resolved: 1, closed: 0 });
  assert.equal(record.status, "PENDING"); assert.equal(record.completedAt, time);
  assert.deepEqual(record.result.confidence, { level: "LOW", calibrated: false }); assert.equal(record.result.advisoryOnly, true);
  assert.deepEqual(record.explainability, { inputDataVersion: "transaction-risk.v1", sourceTransactionVersion: 9, confidenceMeaning: "uncalibrated ordinal level", advisoryOnly: true });
  assert.equal(f.audits.length, 1); assert.deepEqual(Object.keys(f.audits[0].metadata).sort(), ["inputDataVersion", "modelIdentifier", "modelVersion", "provider", "sourceTransactionVersion", "transactionId"].sort());
});

test("disabled provider and non-admin or stale account fail closed without persistence", async () => {
  const f = fixture();
  const disabled = createAiService({ enabled: false });
  await assert.rejects(disabled.assessTransactionRisk({ auth, transactionId }), (error) => error.statusCode === 503);
  await assert.rejects(f.service.assessTransactionRisk({ auth: { ...auth, role: "USER" }, transactionId }), (error) => error.statusCode === 403);
  await assert.rejects(f.service.assessTransactionRisk({ auth: { ...auth, assuranceLevel: "RECOVERY_CODE_VERIFIED" }, transactionId }), (error) => error.statusCode === 403);
  assert.equal(f.persisted.length, 0);
});

test("changed transaction version prevents persistence of stale assessment", async () => {
  const f = fixture({ currentVersion: 10 });
  await assert.rejects(f.service.assessTransactionRisk({ auth, transactionId }), (error) => error.code === "AI_INPUT_STALE");
  assert.equal(f.persisted.length, 0);
});

test("persistence and audit failures return safe unavailable errors", async () => {
  const f = fixture({ failAudit: true });
  await assert.rejects(f.service.assessTransactionRisk({ auth, transactionId }), (error) => error.code === "AI_ASSESSMENT_UNAVAILABLE" && !error.message.includes("db failure"));
});
