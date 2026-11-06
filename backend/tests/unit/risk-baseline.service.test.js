import assert from "node:assert/strict";
import test from "node:test";
import { createRiskBaselineService, evaluateRiskBaseline, RISK_BASELINE_POLICY_VERSION } from "../../src/services/risk-baseline.service.js";

const time = new Date("2026-11-07T12:00:00Z");
const input = (overrides = {}) => ({ inputDataVersion: "transaction-risk.v1", transaction: { status: "FUNDED", amountMinor: "4200", currency: "INR", ageDays: 1, version: 8 }, paymentAttempts: { created: 0, pending: 0, captured: 1, failed: 0, cancelled: 0 }, disputes: { open: 0, underReview: 0, resolved: 0, closed: 0 }, ...overrides });

test("risk baseline is deterministic for identical versioned input and timestamps", () => {
  const args = { input: input(), sourceTransactionVersion: 8, assessedAt: time };
  assert.deepEqual(evaluateRiskBaseline(args), evaluateRiskBaseline(args));
  assert.equal(evaluateRiskBaseline(args).riskLevel, "LOW");
  assert.equal(evaluateRiskBaseline(args).score, null);
  assert.equal(evaluateRiskBaseline(args).indicators.policyVersion, RISK_BASELINE_POLICY_VERSION);
});

test("failed-attempt threshold is exactly one and explanation identifies its input", () => {
  const none = input({ paymentAttempts: { created: 0, pending: 0, captured: 0, failed: 0, cancelled: 0 } });
  const one = input({ paymentAttempts: { created: 0, pending: 0, captured: 0, failed: 1, cancelled: 0 } });
  const many = input({ paymentAttempts: { created: 0, pending: 0, captured: 0, failed: 4, cancelled: 0 } });
  assert.equal(evaluateRiskBaseline({ input: none, assessedAt: time }).riskLevel, "LOW");
  const finding = evaluateRiskBaseline({ input: one, assessedAt: time }).indicators.findings[0];
  assert.equal(finding.code, "PAYMENT_FAILURE_HISTORY"); assert.equal(finding.severity, "MEDIUM");
  assert.deepEqual(finding.inputFields, ["paymentAttempts.failed"]);
  assert.match(finding.explanation, /not proof of misconduct/);
  assert.deepEqual(evaluateRiskBaseline({ input: many, assessedAt: time }).indicators.findings, evaluateRiskBaseline({ input: one, assessedAt: time }).indicators.findings);
});

test("one active dispute triggers high review priority; resolved and closed disputes do not", () => {
  const active = input({ disputes: { open: 0, underReview: 1, resolved: 0, closed: 0 } });
  const historic = input({ disputes: { open: 0, underReview: 0, resolved: 2, closed: 3 } });
  const findings = evaluateRiskBaseline({ input: active, assessedAt: time }).indicators.findings;
  assert.equal(evaluateRiskBaseline({ input: active, assessedAt: time }).riskLevel, "HIGH");
  assert.deepEqual(findings[0].inputFields, ["disputes.open", "disputes.underReview"]);
  assert.equal(evaluateRiskBaseline({ input: historic, assessedAt: time }).riskLevel, "LOW");
  assert.equal(evaluateRiskBaseline({ input: input({ ...active, paymentAttempts: { created: 0, pending: 0, captured: 0, failed: 1, cancelled: 0 } }), assessedAt: time }).riskLevel, "HIGH");
});

test("missing, stale-format and inconsistent inputs are explicitly insufficient, never low", () => {
  for (const invalid of [null, { ...input(), paymentAttempts: undefined }, input({ disputes: { open: -1, underReview: 0, resolved: 0, closed: 0 } }), input({ transaction: { ...input().transaction, ageDays: -1 } })]) {
    const result = evaluateRiskBaseline({ input: invalid, sourceTransactionVersion: 8, assessedAt: time });
    assert.equal(result.riskLevel, "INSUFFICIENT_DATA");
    assert.equal(result.indicators.dataQuality.complete, false);
    assert.equal(result.indicators.findings[0].code, "INPUT_DATA_INVALID");
  }
});

const fixture = ({ currentVersion = 8, failAudit = false } = {}) => {
  const rows = []; const audit = []; let readVersion = currentVersion; let currentUser = { id: "admin", role: "ADMIN", status: "ACTIVE", authVersion: 2 };
  const tx = {
    user: { findUnique: async () => currentUser },
    $queryRaw: async () => [{ version: readVersion }],
    transaction: { findUnique: async () => ({ id: "transaction", status: "FUNDED", amountMinor: 4200n, currency: "INR ", createdAt: new Date("2026-11-06T12:00:00Z"), version: 8 }) },
    paymentAttempt: { groupBy: async () => [{ status: "FAILED", _count: { _all: 1 } }] },
    dispute: { groupBy: async () => [] },
    riskAssessment: { create: async ({ data }) => { rows.push(data); return { id: `risk-${rows.length}`, ...data, createdAt: time }; } },
    auditLog: { create: async ({ data }) => { if (failAudit) throw new Error("private db detail"); audit.push(data); return { id: "audit" }; } },
  };
  const prisma = { async $transaction(callback) { const rowCount = rows.length; const auditCount = audit.length; try { return await callback(tx); } catch (error) { rows.splice(rowCount); audit.splice(auditCount); throw error; } } };
  const auth = { userId: "admin", role: "ADMIN", authVersion: 2, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: time };
  const service = createRiskBaselineService({ getClient: async () => prisma, now: () => time });
  return { service, rows, audit, auth, setVersion: (version) => { readVersion = version; }, setUser: (user) => { currentUser = user; } };
};

test("service appends versioned RiskAssessment history and only safe provenance to audit", async () => {
  const f = fixture();
  const first = await f.service.assessTransactionRisk({ auth: f.auth, transactionId: "transaction" });
  const second = await f.service.assessTransactionRisk({ auth: f.auth, transactionId: "transaction" });
  assert.equal(first.rulesetVersion, RISK_BASELINE_POLICY_VERSION); assert.equal(second.id, "risk-2");
  assert.equal(f.rows.length, 2); assert.equal(f.rows[0].riskLevel, "MEDIUM");
  assert.equal(f.rows[0].indicators.sourceTransactionVersion, 8);
  assert.equal(f.rows[0].indicators.inputDataVersion, "transaction-risk.v1");
  assert.equal(f.audit[0].action, "TRANSACTION_RISK_BASELINE_ASSESSED");
  assert.equal(JSON.stringify(f.audit[0]).includes("paymentAttempts"), false);
});

test("stale source, insufficient privileges, unavailable TOTP and storage errors fail closed", async () => {
  const f = fixture(); f.setVersion(9);
  await assert.rejects(f.service.assessTransactionRisk({ auth: f.auth, transactionId: "transaction" }), (error) => error.code === "RISK_BASELINE_INPUT_STALE");
  await assert.rejects(f.service.assessTransactionRisk({ auth: { ...f.auth, role: "USER" }, transactionId: "transaction" }), (error) => error.statusCode === 403);
  await assert.rejects(f.service.assessTransactionRisk({ auth: { ...f.auth, assuranceLevel: "RECOVERY_CODE_VERIFIED" }, transactionId: "transaction" }), (error) => error.statusCode === 403);
  const broken = fixture({ failAudit: true });
  await assert.rejects(broken.service.assessTransactionRisk({ auth: broken.auth, transactionId: "transaction" }), (error) => error.code === "RISK_BASELINE_UNAVAILABLE" && !error.message.includes("private db detail"));
  assert.equal(broken.rows.length, 0); assert.equal(broken.audit.length, 0);
  const inactive = fixture(); inactive.setUser({ id: "admin", role: "ADMIN", status: "INACTIVE", authVersion: 2 });
  await assert.rejects(inactive.service.assessTransactionRisk({ auth: inactive.auth, transactionId: "transaction" }), (error) => error.statusCode === 403);
});
