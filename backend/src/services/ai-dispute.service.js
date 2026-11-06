import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { disputeAssistanceInputSchema, disputeAssistanceResultSchema } from "../validators/ai.validator.js";

const unavailable = () => new ApiError(503, "AI_DISPUTE_ASSISTANCE_UNAVAILABLE", "Dispute assistance is temporarily unavailable");
const denied = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const stale = () => new ApiError(409, "AI_DISPUTE_INPUT_STALE", "Dispute changed during assessment; retry the request");
const invalidInput = () => new ApiError(422, "AI_DISPUTE_INPUT_INVALID", "Dispute data is not eligible for automated assistance");
const hasTotpSession = (auth, at) => auth?.assuranceLevel === "TOTP_VERIFIED" && auth.mfaEnabled === true && auth.mfaVerifiedAt instanceof Date
  && Number.isFinite(auth.mfaVerifiedAt.getTime()) && auth.mfaVerifiedAt.getTime() <= at.getTime();

// Remove common direct identifiers before the bounded narrative is sent to a configured adapter.
// Evidence bytes, filenames, object keys, user IDs and activity messages are never selected.
export const redactDisputeNarrative = (value) => String(value ?? "")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
  .replace(/https?:\/\/[^\s]+/gi, "[REDACTED]")
  .replace(/(?<!\w)\+?\d[\d .()\-]{7,}\d(?!\w)/g, "[REDACTED]")
  .replace(/\b\d{8,}\b/g, "[REDACTED]")
  .slice(0, 4000);

const countEvidence = (rows) => {
  const result = { DELIVERY: 0, WORK_PROGRESS: 0, COMMUNICATION: 0, OTHER: 0 };
  for (const row of rows) {
    if (!Object.hasOwn(result, row.category) || !Number.isSafeInteger(row._count?._all) || row._count._all < 0) throw new Error("Invalid evidence aggregate");
    result[row.category] = row._count._all;
  }
  return result;
};

export const createAiDisputeService = ({ getClient = getPrismaClient, adapter, enabled = false, provider, modelIdentifier, modelVersion, now = () => new Date() } = {}) => {
  const assessDispute = async ({ auth, disputeId, requestId } = {}) => {
    if (!enabled || adapter?.capabilities?.disputeAssistance !== true || typeof adapter?.assessDispute !== "function"
      || adapter.provider !== provider || adapter.modelIdentifier !== modelIdentifier || adapter.modelVersion !== modelVersion) throw unavailable();
    const startedAt = now();
    if (!auth?.userId || auth.role !== "ADMIN" || !Number.isSafeInteger(auth.authVersion) || !hasTotpSession(auth, startedAt)) throw denied();
    let prisma;
    try { prisma = await getClient(); } catch { throw unavailable(); }
    let snapshot;
    try {
      snapshot = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, role: true, status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== auth.authVersion) throw denied();
        const dispute = await tx.dispute.findUnique({ where: { id: disputeId }, select: { id: true, transactionId: true, status: true, category: true, description: true, createdAt: true, version: true } });
        if (!dispute) throw notFound();
        if (dispute.status !== "UNDER_REVIEW") throw new ApiError(409, "DISPUTE_NOT_UNDER_REVIEW", "Dispute is not available for review assistance");
        const evidenceRows = await tx.evidence.groupBy({ by: ["category"], where: { disputeId }, _count: { _all: true } });
        const asOf = now();
        const ageDays = dispute.createdAt instanceof Date && Number.isFinite(dispute.createdAt.getTime()) ? Math.floor((asOf.getTime() - dispute.createdAt.getTime()) / 86_400_000) : -1;
        const input = disputeAssistanceInputSchema.parse({ inputDataVersion: "dispute-assistance.v1", dispute: { category: dispute.category, status: dispute.status,
          description: redactDisputeNarrative(dispute.description), ageDays, version: dispute.version }, evidenceCounts: countEvidence(evidenceRows) });
        return { input, disputeId: dispute.id, transactionId: dispute.transactionId, version: dispute.version };
      }, { isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === "ZodError") throw invalidInput();
      throw unavailable();
    }

    let providerResult;
    try {
      const response = await adapter.assessDispute(snapshot.input);
      if (response?.provider !== provider || response?.modelIdentifier !== modelIdentifier || response?.modelVersion !== modelVersion) throw new Error("provenance mismatch");
      providerResult = disputeAssistanceResultSchema.parse(response.result);
    } catch { throw unavailable(); }

    const completedAt = now();
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${snapshot.transactionId}::uuid FOR SHARE`;
        const lockedDispute = await tx.$queryRaw`SELECT "id" FROM "disputes" WHERE "id" = ${snapshot.disputeId}::uuid AND "transaction_id" = ${snapshot.transactionId}::uuid FOR SHARE`;
        if (!lockedDispute.length) throw notFound();
        const [user, current] = await Promise.all([
          tx.user.findUnique({ where: { id: auth.userId }, select: { role: true, status: true, authVersion: true } }),
          tx.dispute.findUnique({ where: { id: snapshot.disputeId }, select: { transactionId: true, status: true, version: true } }),
        ]);
        if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== auth.authVersion) throw denied();
        if (!current || current.transactionId !== snapshot.transactionId) throw notFound();
        if (current.status !== "UNDER_REVIEW" || current.version !== snapshot.version) throw stale();
        const record = await tx.aIAnalysis.create({ data: {
          disputeId: snapshot.disputeId, status: "PENDING", provider, modelIdentifier, modelVersion, analysisType: "DISPUTE_ASSISTANCE",
          result: { ...providerResult, advisoryOnly: true }, explainability: { inputDataVersion: snapshot.input.inputDataVersion, sourceDisputeVersion: snapshot.version, policy: "human-review-only", evidenceContentIncluded: false, advisoryOnly: true }, completedAt,
        }, select: { id: true, disputeId: true, status: true, provider: true, modelIdentifier: true, modelVersion: true, analysisType: true, result: true, explainability: true, createdAt: true, completedAt: true } });
        await tx.auditLog.create({ data: { actorUserId: auth.userId, action: "AI_DISPUTE_ASSISTANCE_CREATED", entityType: "AIAnalysis", entityId: record.id, requestId: requestId ?? null,
          metadata: { disputeId: snapshot.disputeId, provider, modelIdentifier, modelVersion, inputDataVersion: snapshot.input.inputDataVersion, sourceDisputeVersion: snapshot.version } } });
        return record;
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };
  return Object.freeze({ assessDispute });
};
