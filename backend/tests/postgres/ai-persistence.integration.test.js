import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createAiService } from "../../src/services/ai.service.js";
import { createRiskBaselineService } from "../../src/services/risk-baseline.service.js";
import { createAiDisputeService } from "../../src/services/ai-dispute.service.js";

const enabled = process.env.TRUSTBRIDGE_AI_PG_TESTS === "1";
const loopback = (ip) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(ip);
const providerResult = { score: 20, riskLevel: "LOW", indicators: [], confidenceLevel: "LOW", recommendation: "NONE", summary: "No configured risk indicator was identified." };

test("isolated PostgreSQL persists concurrent advisory analyses and rejects a stale source snapshot", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl());
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(baseline.hostname)); assert.equal(baseline.port || "5432", "5432");
  assert.equal(decodeURIComponent(baseline.pathname.slice(1)), "Trustbridge", "only derive the separately designated test DB from the approved local configuration");
  const target = new URL(baseline); target.pathname = "/trustbridge_test";
  const [{ PrismaClient }, { PrismaPg }, { Client }, fs] = await Promise.all([import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg"), import("node:fs/promises")]);
  const inspection = new Client({ connectionString: target.toString() }); await inspection.connect();
  try {
    const identity = (await inspection.query("SELECT current_database() database,current_setting('server_version') version,current_setting('port') port,inet_server_addr()::text server,inet_client_addr()::text client")).rows[0];
    const history = (await inspection.query("SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations")).rows;
    const folders = (await fs.readdir("./prisma/migrations", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.equal(identity.database, "trustbridge_test"); assert.match(identity.version, /^17\./); assert.equal(identity.port, "5432"); assert.ok(loopback(identity.server)); assert.ok(loopback(identity.client));
    assert.equal(history.filter((row) => !row.finished_at && !row.rolled_back_at).length, 0);
    assert.deepEqual(history.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name).sort(), folders);
  } finally { await inspection.end(); }

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString() }) });
  const [a, b] = [makeClient(), makeClient()]; const ids = [randomUUID(), randomUUID(), randomUUID()]; const transactionId = randomUUID(); const disputeId = randomUUID();
  t.after(async () => {
    try {
      const risks = await a.riskAssessment.findMany({ where: { transactionId }, select: { id: true } });
      const riskIds = risks.map(({ id }) => id);
      if (riskIds.length) { await a.auditLog.deleteMany({ where: { entityId: { in: riskIds } } }); await a.riskAssessment.deleteMany({ where: { id: { in: riskIds } } }); }
      const analyses = await a.aIAnalysis.findMany({ where: { OR: [{ transactionId }, { disputeId }] }, select: { id: true } });
      const analysisIds = analyses.map(({ id }) => id);
      if (analysisIds.length) { await a.auditLog.deleteMany({ where: { entityId: { in: analysisIds } } }); await a.aIAnalysis.deleteMany({ where: { id: { in: analysisIds } } }); }
      await a.evidence.deleteMany({ where: { disputeId } });
      await a.dispute.deleteMany({ where: { id: disputeId } });
      await a.transactionParticipant.deleteMany({ where: { transactionId } }); await a.transaction.deleteMany({ where: { id: transactionId } }); await a.user.deleteMany({ where: { id: { in: ids } } });
    } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
  });
  for (let i = 0; i < ids.length; i += 1) await a.user.create({ data: { id: ids[i], email: `${ids[i]}@tb090-pg.invalid`, passwordHash: "synthetic-test-only", role: i === 2 ? "ADMIN" : "USER", status: "ACTIVE" } });
  await a.transaction.create({ data: { id: transactionId, buyerId: ids[0], sellerId: ids[1], createdById: ids[0], amountMinor: 4200n, currency: "INR", status: "FUNDED", terms: { description: "synthetic fixture" }, participants: { create: [{ userId: ids[0], role: "BUYER" }, { userId: ids[1], role: "SELLER" }] } } });
  const inputAuth = { userId: ids[2], role: "ADMIN", authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() };
  const makeService = (client, adapter) => createAiService({ getClient: async () => client, enabled: true, provider: "mock", modelIdentifier: "risk-test", modelVersion: "1", adapter });
  let arrivals = 0; let openGate; const gate = new Promise((resolve) => { openGate = resolve; });
  const barrierAdapter = { provider: "mock", modelIdentifier: "risk-test", modelVersion: "1", capabilities: { transactionRiskAssessment: true }, async assessTransactionRisk() { arrivals += 1; if (arrivals === 2) openGate(); await gate; return { provider: "mock", modelIdentifier: "risk-test", modelVersion: "1", result: providerResult }; } };
  const records = await Promise.all([a, b].map((client) => makeService(client, barrierAdapter).assessTransactionRisk({ auth: inputAuth, transactionId })));
  assert.equal(records.length, 2); assert.ok(records.every((record) => record.status === "PENDING" && record.result.advisoryOnly));
  assert.equal(await a.aIAnalysis.count({ where: { transactionId, analysisType: "TRANSACTION_RISK" } }), 2);

  const staleAdapter = { ...barrierAdapter, async assessTransactionRisk() { await a.transaction.update({ where: { id: transactionId }, data: { version: { increment: 1 } } }); return { provider: "mock", modelIdentifier: "risk-test", modelVersion: "1", result: providerResult }; } };
  await assert.rejects(makeService(a, staleAdapter).assessTransactionRisk({ auth: inputAuth, transactionId }), (error) => error.code === "AI_INPUT_STALE");
  assert.equal(await a.aIAnalysis.count({ where: { transactionId, analysisType: "TRANSACTION_RISK" } }), 2);

  const baselines = await Promise.all([a, b].map((client) => createRiskBaselineService({ getClient: async () => client }).assessTransactionRisk({ auth: inputAuth, transactionId })));
  const currentTransaction = await a.transaction.findUnique({ where: { id: transactionId }, select: { version: true } });
  assert.equal(baselines.length, 2);
  assert.ok(baselines.every((record) => record.rulesetVersion === "trustbridge-risk-baseline.v1" && record.indicators.sourceTransactionVersion === currentTransaction.version));
  assert.equal(await a.riskAssessment.count({ where: { transactionId, rulesetVersion: "trustbridge-risk-baseline.v1" } }), 2);

  await a.dispute.create({ data: { id: disputeId, transactionId, openedById: ids[0], status: "UNDER_REVIEW", category: "QUALITY", description: "Synthetic dispute narrative with no personal information." } });
  await a.evidence.create({ data: { disputeId, uploadedById: ids[0], category: "DELIVERY", storageObjectKey: `test-only/${randomUUID()}`, contentType: "image/png", sizeBytes: 128n, sha256Hash: "a".repeat(64) } });
  const disputeOutput = { summary: "A human should compare delivery evidence with the agreed terms.", suggestedCategory: "QUALITY", missingEvidenceCategories: [], reviewSteps: ["COMPARE_AGREED_TERMS", "HUMAN_RESOLUTION_REQUIRED"], advisoryOnly: true };
  const disputeAdapter = { provider: "mock", modelIdentifier: "dispute-test", modelVersion: "1", capabilities: { disputeAssistance: true }, async assessDispute() { return { provider: "mock", modelIdentifier: "dispute-test", modelVersion: "1", result: disputeOutput }; } };
  const disputeService = (client, adapter = disputeAdapter) => createAiDisputeService({ getClient: async () => client, adapter, enabled: true, provider: "mock", modelIdentifier: "dispute-test", modelVersion: "1" });
  const assistance = await Promise.all([a, b].map((client) => disputeService(client).assessDispute({ auth: inputAuth, disputeId })));
  assert.equal(assistance.length, 2); assert.ok(assistance.every((row) => row.disputeId === disputeId && row.analysisType === "DISPUTE_ASSISTANCE" && row.explainability.evidenceContentIncluded === false));
  assert.equal(await a.aIAnalysis.count({ where: { disputeId, analysisType: "DISPUTE_ASSISTANCE" } }), 2);
  const staleDisputeAdapter = { ...disputeAdapter, async assessDispute() { await a.dispute.update({ where: { id: disputeId }, data: { version: { increment: 1 } } }); return { provider: "mock", modelIdentifier: "dispute-test", modelVersion: "1", result: disputeOutput }; } };
  await assert.rejects(disputeService(a, staleDisputeAdapter).assessDispute({ auth: inputAuth, disputeId }), (error) => error.code === "AI_DISPUTE_INPUT_STALE");
  assert.equal(await a.aIAnalysis.count({ where: { disputeId, analysisType: "DISPUTE_ASSISTANCE" } }), 2);
});
