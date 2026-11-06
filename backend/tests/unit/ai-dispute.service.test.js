import assert from "node:assert/strict";
import test from "node:test";
import { createAiDisputeService, redactDisputeNarrative } from "../../src/services/ai-dispute.service.js";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disputeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const transactionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const time = new Date("2026-11-07T12:00:00Z");
const output = { summary: "The claim concerns a possible quality mismatch.", suggestedCategory: "QUALITY", missingEvidenceCategories: ["DELIVERY"], reviewSteps: ["COMPARE_AGREED_TERMS", "HUMAN_RESOLUTION_REQUIRED"], advisoryOnly: true };
const auth = { userId: adminId, role: "ADMIN", authVersion: 4, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date("2026-11-07T10:00:00Z") };

const fixture = ({ currentVersion = 5, status = "UNDER_REVIEW", failAudit = false, userStatus = "ACTIVE", mutateVersionOnAssessment = false } = {}) => {
  const inputs = []; const records = []; const audits = []; let storedVersion = currentVersion;
  const client = {
    async $transaction(callback) { const recordCount = records.length; const auditCount = audits.length; try { return await callback(tx); } catch (error) { records.splice(recordCount); audits.splice(auditCount); throw error; } },
  };
  const tx = {
    user: { findUnique: async () => ({ id: adminId, role: "ADMIN", status: userStatus, authVersion: 4 }) },
    dispute: { findUnique: async () => ({ id: disputeId, transactionId, status, category: "QUALITY", description: "Work quality differs. Contact customer@example.test at +1 212 555 1212.", createdAt: new Date("2026-11-05T12:00:00Z"), version: storedVersion }) },
    evidence: { groupBy: async (query) => { assert.deepEqual(query.by, ["category"]); return [{ category: "WORK_PROGRESS", _count: { _all: 2 } }]; } },
    $queryRaw: async () => [{ id: transactionId }],
    aIAnalysis: { create: async ({ data }) => { records.push(data); return { id: `analysis-${records.length}`, ...data, createdAt: time }; } },
    auditLog: { create: async ({ data }) => { if (failAudit) throw new Error("private database details"); audits.push(data); return { id: "audit" }; } },
  };
  const adapter = { provider: "gateway", modelIdentifier: "dispute-v1", modelVersion: "4", capabilities: { disputeAssistance: true }, async assessDispute(input) { inputs.push(input); if (mutateVersionOnAssessment) storedVersion += 1; return { provider: "gateway", modelIdentifier: "dispute-v1", modelVersion: "4", result: output }; } };
  const service = createAiDisputeService({ getClient: async () => client, adapter, enabled: true, provider: "gateway", modelIdentifier: "dispute-v1", modelVersion: "4", now: () => time });
  return { service, inputs, records, audits, setVersion: (version) => { storedVersion = version; }, getVersion: () => storedVersion };
};

test("dispute assistance sends minimized, redacted input and persists append-only advisory provenance", async () => {
  const f = fixture();
  const record = await f.service.assessDispute({ auth, disputeId, requestId: "request" });
  const sent = f.inputs[0];
  assert.equal(sent.inputDataVersion, "dispute-assistance.v1");
  assert.equal(sent.dispute.description.includes("customer@example.test"), false);
  assert.equal(sent.dispute.description.includes("212 555 1212"), false);
  assert.deepEqual(sent.evidenceCounts, { DELIVERY: 0, WORK_PROGRESS: 2, COMMUNICATION: 0, OTHER: 0 });
  for (const field of ["uploadedById", "storageObjectKey", "originalFilename", "evidenceBytes", "transactionId", "userId"]) assert.equal(JSON.stringify(sent).includes(field), false);
  assert.equal(record.disputeId, disputeId); assert.equal(record.analysisType, "DISPUTE_ASSISTANCE"); assert.equal(record.status, "PENDING");
  assert.equal(record.result.advisoryOnly, true); assert.equal(record.explainability.sourceDisputeVersion, 5); assert.equal(record.explainability.evidenceContentIncluded, false);
  assert.equal(f.audits[0].action, "AI_DISPUTE_ASSISTANCE_CREATED"); assert.equal(JSON.stringify(f.audits[0]).includes("customer@example.test"), false);
  await f.service.assessDispute({ auth, disputeId });
  assert.equal(f.records.length, 2);
});

test("dispute assistance redacts direct identifiers and rejects invalid snapshots", async () => {
  assert.equal(redactDisputeNarrative("Mail a@b.test or call 555-123-4567"), "Mail [REDACTED] or call [REDACTED]");
  const stale = fixture({ mutateVersionOnAssessment: true });
  await assert.rejects(stale.service.assessDispute({ auth, disputeId }), (error) => error.code === "AI_DISPUTE_INPUT_STALE");
  const wrongStatus = fixture({ status: "OPEN" });
  await assert.rejects(wrongStatus.service.assessDispute({ auth, disputeId }), (error) => error.code === "DISPUTE_NOT_UNDER_REVIEW");
});

test("dispute assistance fails closed for disabled providers, unauthorized assurance and persistence failures", async () => {
  const f = fixture();
  await assert.rejects(createAiDisputeService({ enabled: false }).assessDispute({ auth, disputeId }), (error) => error.statusCode === 503);
  await assert.rejects(f.service.assessDispute({ auth: { ...auth, role: "USER" }, disputeId }), (error) => error.statusCode === 403);
  await assert.rejects(f.service.assessDispute({ auth: { ...auth, assuranceLevel: "RECOVERY_CODE_VERIFIED" }, disputeId }), (error) => error.statusCode === 403);
  await assert.rejects(f.service.assessDispute({ auth: { ...auth, assuranceLevel: "PASSWORD_ONLY" }, disputeId }), (error) => error.statusCode === 403);
  const inactive = fixture({ userStatus: "INACTIVE" });
  await assert.rejects(inactive.service.assessDispute({ auth, disputeId }), (error) => error.statusCode === 403);
  const failed = fixture({ failAudit: true });
  await assert.rejects(failed.service.assessDispute({ auth, disputeId }), (error) => error.code === "AI_DISPUTE_ASSISTANCE_UNAVAILABLE" && !error.message.includes("private"));
  assert.equal(failed.records.length, 0); assert.equal(failed.audits.length, 0);
});
