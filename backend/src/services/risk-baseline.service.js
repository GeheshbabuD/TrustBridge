import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { transactionRiskInputSchema } from "../validators/ai.validator.js";

export const RISK_BASELINE_POLICY_VERSION = "trustbridge-risk-baseline.v1";
const INPUT_VERSION = "transaction-risk.v1";
const denied = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const unavailable = () => new ApiError(503, "RISK_BASELINE_UNAVAILABLE", "Risk assessment is temporarily unavailable");
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const stale = () => new ApiError(409, "RISK_BASELINE_INPUT_STALE", "Transaction changed during assessment; retry the request");

const recentTotp = (auth, at) => auth?.assuranceLevel === "TOTP_VERIFIED" && auth.mfaEnabled === true
  && auth.mfaVerifiedAt instanceof Date && Number.isFinite(auth.mfaVerifiedAt.getTime())
  && auth.mfaVerifiedAt.getTime() <= at.getTime() && at.getTime() - auth.mfaVerifiedAt.getTime() <= 300_000;

const aggregateCounts = (rows, names) => {
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  for (const row of rows) {
    if (!Object.hasOwn(counts, row.status)) throw new Error("Unknown persisted workflow status");
    const value = row._count?._all ?? row.count;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid persisted aggregate");
    counts[row.status] = value;
  }
  return counts;
};

const assess = (input, sourceVersion, assessedAt) => {
  const parsed = transactionRiskInputSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean))].sort();
    return {
      riskLevel: "INSUFFICIENT_DATA", score: null, recommendation: "MANUAL_DATA_REVIEW",
      indicators: { policyVersion: RISK_BASELINE_POLICY_VERSION, inputDataVersion: INPUT_VERSION, sourceTransactionVersion: sourceVersion, assessedAt: assessedAt.toISOString(), dataQuality: { complete: false, issue: "INPUT_MISSING_OR_INVALID", fields }, findings: [{ code: "INPUT_DATA_INVALID", severity: "UNKNOWN", explanation: "Required transaction risk inputs are missing or inconsistent; no low-risk conclusion was made.", inputFields: fields }] },
    };
  }
  const findings = [];
  if (parsed.data.disputes.open + parsed.data.disputes.underReview > 0) findings.push({
    code: "ACTIVE_DISPUTE", severity: "HIGH", explanation: "A persisted dispute is open or under review and warrants human review.", inputFields: ["disputes.open", "disputes.underReview"],
  });
  if (parsed.data.paymentAttempts.failed > 0) findings.push({
    code: "PAYMENT_FAILURE_HISTORY", severity: "MEDIUM", explanation: "At least one persisted payment attempt is marked failed; this can occur during ordinary provider errors and is not proof of misconduct.", inputFields: ["paymentAttempts.failed"],
  });
  const riskLevel = findings.some((finding) => finding.code === "ACTIVE_DISPUTE") ? "HIGH" : findings.length ? "MEDIUM" : "LOW";
  return {
    riskLevel, score: null, recommendation: findings.length ? "MANUAL_REVIEW" : "NO_RULE_TRIGGERED",
    indicators: { policyVersion: RISK_BASELINE_POLICY_VERSION, inputDataVersion: parsed.data.inputDataVersion, sourceTransactionVersion: sourceVersion, assessedAt: assessedAt.toISOString(), dataQuality: { complete: true }, findings },
  };
};

export const evaluateRiskBaseline = ({ input, sourceTransactionVersion, assessedAt = new Date() } = {}) => {
  if (!(assessedAt instanceof Date) || !Number.isFinite(assessedAt.getTime())) throw new TypeError("A valid assessment timestamp is required");
  return assess(input, Number.isSafeInteger(sourceTransactionVersion) && sourceTransactionVersion > 0 ? sourceTransactionVersion : null, assessedAt);
};

export const createRiskBaselineService = ({ getClient = getPrismaClient, now = () => new Date() } = {}) => {
  const assessTransactionRisk = async ({ auth, transactionId, requestId } = {}) => {
    const startedAt = now();
    if (!auth?.userId || auth.role !== "ADMIN" || !Number.isSafeInteger(auth.authVersion) || !recentTotp(auth, startedAt)) throw denied();
    let prisma;
    try { prisma = await getClient(); } catch { throw unavailable(); }
    try {
      return await prisma.$transaction(async (tx) => {
        // Match domain writer lock order (user, then transaction); keep lifecycle aggregates stable while reading and appending.
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${auth.userId}::uuid FOR SHARE`;
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, role: true, status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== auth.authVersion) throw denied();
        // Transaction, payment and dispute writers serialize on this same row before changing lifecycle data.
        const locked = await tx.$queryRaw`SELECT "version" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR SHARE`;
        if (!locked.length) throw notFound();
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true, version: true } });
        if (!transaction) throw notFound();
        const [attemptRows, disputeRows] = await Promise.all([
          tx.paymentAttempt.groupBy({ by: ["status"], where: { transactionId }, _count: { _all: true } }),
          tx.dispute.groupBy({ by: ["status"], where: { transactionId }, _count: { _all: true } }),
        ]);
        const payment = aggregateCounts(attemptRows, ["CREATED", "PENDING", "CAPTURED", "FAILED", "CANCELLED"]);
        const dispute = aggregateCounts(disputeRows, ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"]);
        const assessedAt = now();
        const input = {
          inputDataVersion: INPUT_VERSION,
          transaction: { status: transaction.status, amountMinor: typeof transaction.amountMinor === "bigint" ? transaction.amountMinor.toString() : transaction.amountMinor, currency: transaction.currency?.trim(), ageDays: transaction.createdAt instanceof Date && Number.isFinite(transaction.createdAt.getTime()) ? Math.floor((assessedAt.getTime() - transaction.createdAt.getTime()) / 86_400_000) : Number.NaN, version: transaction.version },
          paymentAttempts: { created: payment.CREATED, pending: payment.PENDING, captured: payment.CAPTURED, failed: payment.FAILED, cancelled: payment.CANCELLED },
          disputes: { open: dispute.OPEN, underReview: dispute.UNDER_REVIEW, resolved: dispute.RESOLVED, closed: dispute.CLOSED },
        };
        const assessment = assess(input, transaction.version, assessedAt);
        const currentUser = await tx.user.findUnique({ where: { id: auth.userId }, select: { status: true, role: true, authVersion: true } });
        if (!currentUser || currentUser.status !== "ACTIVE" || currentUser.role !== "ADMIN" || currentUser.authVersion !== auth.authVersion) throw denied();
        const currentVersion = await tx.$queryRaw`SELECT "version" FROM "transactions" WHERE "id" = ${transactionId}::uuid`;
        if (!currentVersion.length) throw notFound();
        if (Number(currentVersion[0].version) !== transaction.version) throw stale();
        const record = await tx.riskAssessment.create({ data: {
          transactionId, status: "PENDING", score: assessment.score, riskLevel: assessment.riskLevel, indicators: assessment.indicators,
          recommendation: assessment.recommendation, rulesetVersion: RISK_BASELINE_POLICY_VERSION, completedAt: assessedAt,
        }, select: { id: true, status: true, score: true, riskLevel: true, indicators: true, recommendation: true, rulesetVersion: true, createdAt: true, completedAt: true } });
        await tx.auditLog.create({ data: { actorUserId: auth.userId, action: "TRANSACTION_RISK_BASELINE_ASSESSED", entityType: "RiskAssessment", entityId: record.id, requestId: requestId ?? null, metadata: { transactionId, rulesetVersion: RISK_BASELINE_POLICY_VERSION, inputDataVersion: INPUT_VERSION, sourceTransactionVersion: transaction.version } } });
        return record;
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };
  return Object.freeze({ assessTransactionRisk });
};
