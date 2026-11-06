import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { transactionRiskInputSchema, transactionRiskResultSchema } from "../validators/ai.validator.js";

const unavailable = () => new ApiError(503, "AI_UNAVAILABLE", "AI assessment is temporarily unavailable");
const denied = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const transientStoreError = () => new ApiError(503, "AI_ASSESSMENT_UNAVAILABLE", "AI assessment is temporarily unavailable");
const dayMs = 86_400_000;
const states = Object.freeze({ paymentAttempts: ["CREATED", "PENDING", "CAPTURED", "FAILED", "CANCELLED"], disputes: ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"] });
const recentTotp = (auth, at) => auth?.assuranceLevel === "TOTP_VERIFIED" && auth.mfaEnabled === true && auth.mfaVerifiedAt instanceof Date
  && Number.isFinite(auth.mfaVerifiedAt.getTime()) && auth.mfaVerifiedAt.getTime() <= at.getTime() && at.getTime() - auth.mfaVerifiedAt.getTime() <= 300_000;

const aggregateCounts = (rows, allowed) => {
  const result = Object.fromEntries(allowed.map((status) => [status, 0]));
  for (const row of rows) if (Object.hasOwn(result, row.status)) result[row.status] = row._count?._all ?? row.count ?? 0;
  return result;
};

export const createAiService = ({ getClient = getPrismaClient, adapter, enabled = false, provider, modelIdentifier, modelVersion, now = () => new Date() } = {}) => {
  const assessTransactionRisk = async ({ auth, transactionId, requestId }) => {
    if (!enabled || !adapter || adapter.capabilities?.transactionRiskAssessment !== true || typeof adapter.assessTransactionRisk !== "function"
      || adapter.provider !== provider || adapter.modelIdentifier !== modelIdentifier || adapter.modelVersion !== modelVersion) throw unavailable();
    if (!auth?.userId || auth.role !== "ADMIN" || !Number.isSafeInteger(auth.authVersion) || !recentTotp(auth, now())) throw denied();
    const prisma = await getClient();
    let snapshot;
    try {
      snapshot = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, role: true, status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== auth.authVersion) throw denied();
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true, version: true } });
        if (!transaction) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
        const [attemptRows, disputeRows] = await Promise.all([
          tx.paymentAttempt.groupBy({ by: ["status"], where: { transactionId }, _count: { _all: true } }),
          tx.dispute.groupBy({ by: ["status"], where: { transactionId }, _count: { _all: true } }),
        ]);
        const asOf = now();
        const paymentCounts = aggregateCounts(attemptRows, states.paymentAttempts);
        const disputeCounts = aggregateCounts(disputeRows, states.disputes);
        const input = transactionRiskInputSchema.parse({
          inputDataVersion: "transaction-risk.v1",
          transaction: { status: transaction.status, amountMinor: transaction.amountMinor.toString(), currency: transaction.currency.trim(), ageDays: Math.max(0, Math.floor((asOf.getTime() - transaction.createdAt.getTime()) / dayMs)), version: transaction.version },
          paymentAttempts: { created: paymentCounts.CREATED, pending: paymentCounts.PENDING, captured: paymentCounts.CAPTURED, failed: paymentCounts.FAILED, cancelled: paymentCounts.CANCELLED },
          disputes: { open: disputeCounts.OPEN, underReview: disputeCounts.UNDER_REVIEW, resolved: disputeCounts.RESOLVED, closed: disputeCounts.CLOSED },
        });
        return { input, version: transaction.version };
      }, { isolationLevel: "RepeatableRead" });
    } catch (error) { if (error instanceof ApiError) throw error; throw transientStoreError(); }

    let output;
    try {
      output = await adapter.assessTransactionRisk(snapshot.input);
      if (output?.provider !== provider || output?.modelIdentifier !== modelIdentifier || output?.modelVersion !== modelVersion) throw new Error("provenance mismatch");
      output = transactionRiskResultSchema.parse(output.result);
    } catch { throw unavailable(); }

    const assessedAt = now();
    const result = {
      score: output.score,
      riskLevel: output.riskLevel,
      indicators: output.indicators,
      confidence: { level: output.confidenceLevel, calibrated: false },
      recommendation: output.recommendation,
      summary: output.summary,
      advisoryOnly: true,
    };
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, role: true, status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== auth.authVersion) throw denied();
        const current = await tx.$queryRaw`SELECT "version" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR SHARE`;
        if (!current.length) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
        if (Number(current[0].version) !== snapshot.version) throw new ApiError(409, "AI_INPUT_STALE", "Transaction changed during assessment; retry the request");
        const record = await tx.aIAnalysis.create({ data: {
          transactionId, status: "PENDING", provider, modelIdentifier, modelVersion, analysisType: "TRANSACTION_RISK",
          result, explainability: { inputDataVersion: snapshot.input.inputDataVersion, sourceTransactionVersion: snapshot.version, confidenceMeaning: "uncalibrated ordinal level", advisoryOnly: true }, completedAt: assessedAt,
        }, select: { id: true, status: true, provider: true, modelIdentifier: true, modelVersion: true, analysisType: true, result: true, explainability: true, createdAt: true, completedAt: true } });
        await tx.auditLog.create({ data: { actorUserId: auth.userId, action: "AI_TRANSACTION_RISK_ASSESSED", entityType: "AIAnalysis", entityId: record.id, requestId: requestId ?? null, metadata: { transactionId, provider, modelIdentifier, modelVersion, inputDataVersion: snapshot.input.inputDataVersion, sourceTransactionVersion: snapshot.version } } });
        return record;
      });
    } catch (error) { if (error instanceof ApiError) throw error; throw transientStoreError(); }
  };
  return Object.freeze({ assessTransactionRisk });
};
