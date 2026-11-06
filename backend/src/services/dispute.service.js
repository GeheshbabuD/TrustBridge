import { createHash, createHmac, randomUUID } from "node:crypto";
import { basename, win32 } from "node:path";
import { getEnv } from "../config/env.js";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { createUnavailableEvidenceStorage } from "./evidence-storage.service.js";
import { evidenceCategorySchema } from "../validators/dispute.validator.js";
import { enqueueTransactionNotice } from "./notification-event.service.js";
import { enqueueBlockchainStatusCommitment } from "./blockchain-event-hash.service.js";

const unavailable = () => new ApiError(503, "DISPUTE_SERVICE_UNAVAILABLE", "Dispute service is temporarily unavailable");
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const conflict = (code = "DISPUTE_CONFLICT") => new ApiError(409, code, "Dispute operation conflicts with current state");
const denied = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const allowedTypes = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const allowedStates = new Set(["FUNDED", "IN_PROGRESS", "DELIVERED"]);
const nowPlusHours = (now, hours) => new Date(now.getTime() + hours * 60 * 60 * 1000);

const detectType = (bytes) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
};

export const createDisputeService = ({ getClient = getPrismaClient, storage = createUnavailableEvidenceStorage(), now = () => new Date(), fingerprintSecret } = {}) => {
  const fingerprint = (value) => createHmac("sha256", fingerprintSecret ?? getEnv().rateLimit.keySecret).update(JSON.stringify(value)).digest("hex");
  const lockTransaction = (tx, id) => tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const lockUser = (tx, id) => tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const lockDispute = (tx, id) => tx.$queryRaw`SELECT "id" FROM "disputes" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const audit = (tx, actorUserId, action, disputeId, transactionId, requestId, metadata = {}) => tx.auditLog.create({
    data: { actorUserId, action, entityType: "Dispute", entityId: disputeId, requestId: requestId ?? null, metadata: { transactionId, ...metadata } }, select: { id: true },
  });
  const userAndRole = async (tx, auth, requiredRole) => {
    const user = await tx.user.findUnique({ where: { id: auth?.userId }, select: { id: true, role: true, status: true, authVersion: true } });
    if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion || (requiredRole && user.role !== requiredRole)) throw denied();
    return user;
  };
  const requireTOTP = (auth) => { if (auth?.assuranceLevel !== "TOTP_VERIFIED" || auth.mfaEnabled !== true || !(auth.mfaVerifiedAt instanceof Date)) throw denied(); };
  const participantRole = async (tx, transaction, userId) => {
    const participant = await tx.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId: transaction.id, userId } }, select: { role: true } });
    const expected = participant?.role === "BUYER" ? transaction.buyerId : participant?.role === "SELLER" ? transaction.sellerId : null;
    return expected === userId ? participant.role : null;
  };
  const appendActivity = async (tx, dispute, actorUserId, type, { message = null, metadata = null } = {}) => {
    const changed = await tx.dispute.updateMany({ where: { id: dispute.id, version: dispute.version }, data: { version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict("DISPUTE_VERSION_CONFLICT");
    return tx.disputeActivity.create({ data: { disputeId: dispute.id, sequence: dispute.version + 1, actorUserId, type, message, metadata } });
  };
  const serialize = (dispute, { activities = [], evidence = [] } = {}) => ({
    id: dispute.id, transactionId: dispute.transactionId, openedById: dispute.openedById,
    status: dispute.status, category: dispute.category, description: dispute.description,
    resolution: dispute.resolution, resolutionAmountMinor: dispute.resolutionAmountMinor?.toString() ?? null,
    version: dispute.version, evidenceDeadlineAt: dispute.evidenceDeadlineAt, responseDeadlineAt: dispute.responseDeadlineAt,
    createdAt: dispute.createdAt, updatedAt: dispute.updatedAt, resolvedAt: dispute.resolvedAt, closedAt: dispute.closedAt,
    activities: activities.map((row) => ({ sequence: row.sequence, actorUserId: row.actorUserId, type: row.type, message: row.message, createdAt: row.createdAt })),
    evidence: evidence.map((row) => ({ id: row.id, uploadedById: row.uploadedById, category: row.category, originalFilename: row.originalFilename, contentType: row.contentType, sizeBytes: row.sizeBytes.toString(), createdAt: row.createdAt })),
  });

  const create = async ({ auth, transactionId, input, idempotencyKey, requestId }) => {
    if (!auth?.userId || auth.role !== "USER" || !Number.isSafeInteger(auth.authVersion) || typeof idempotencyKey !== "string") throw denied();
    const prisma = await getClient();
    const scope = `DISPUTE_CREATE:${transactionId}:${auth.userId}`;
    const requestFingerprint = fingerprint(input);
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId } });
        if (!transaction) throw notFound();
        await lockUser(tx, auth.userId);
        await userAndRole(tx, auth, "USER");
        const role = await participantRole(tx, transaction, auth.userId);
        if (!role) throw notFound();
        const existingRequest = await tx.idempotencyOperation.findUnique({ where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey } } });
        if (existingRequest) {
          if (existingRequest.requestFingerprint !== requestFingerprint) throw conflict("IDEMPOTENCY_KEY_REUSED");
          if (existingRequest.status !== "COMPLETED" || existingRequest.resourceType !== "Dispute" || !existingRequest.resourceId) throw conflict("IDEMPOTENCY_IN_PROGRESS");
          const existing = await tx.dispute.findUnique({ where: { id: existingRequest.resourceId } });
          if (!existing || existing.transactionId !== transactionId) throw notFound();
          return { dispute: serialize(existing), duplicate: true };
        }
        if (!allowedStates.has(transaction.status)) throw conflict("DISPUTE_NOT_ELIGIBLE");
        const escrow = await tx.escrow.findUnique({ where: { transactionId_currency: { transactionId, currency: transaction.currency } } });
        if (!escrow || escrow.status !== "FUNDED" || escrow.balanceMinor <= 0n) throw conflict("DISPUTE_NOT_FUNDED");
        const active = await tx.dispute.findFirst({ where: { transactionId, status: { in: ["OPEN", "UNDER_REVIEW"] } }, select: { id: true } });
        if (active) throw conflict("ACTIVE_DISPUTE_EXISTS");
        await tx.idempotencyOperation.create({ data: { operationScope: scope, idempotencyKey, requestFingerprint, status: "IN_PROGRESS", expiresAt: nowPlusHours(now(), 24) } });
        const dispute = await tx.dispute.create({ data: {
          transactionId, openedById: auth.userId, status: "OPEN", category: input.category, description: input.description,
          evidenceDeadlineAt: nowPlusHours(now(), 72), responseDeadlineAt: nowPlusHours(now(), 48),
        } });
        await tx.disputeActivity.create({ data: { disputeId: dispute.id, sequence: 1, actorUserId: auth.userId, type: "OPENED", metadata: { participantRole: role } } });
        const updated = await tx.transaction.updateMany({ where: { id: transactionId, status: transaction.status, version: transaction.version }, data: { status: "DISPUTED", version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
        await tx.transactionStatusHistory.create({ data: { transactionId, version: transaction.version + 1, previousStatus: transaction.status, newStatus: "DISPUTED", actorUserId: auth.userId, reason: "PARTICIPANT_OPENED_DISPUTE" } });
        await enqueueBlockchainStatusCommitment(tx, { transactionId, version: transaction.version + 1, previousStatus: transaction.status, newStatus: "DISPUTED" });
        await audit(tx, auth.userId, "DISPUTE_OPENED", dispute.id, transactionId, requestId, { category: input.category });
        await enqueueTransactionNotice(tx, { transactionId, template: "DISPUTE_OPENED", discriminator: dispute.id });
        await tx.idempotencyOperation.update({ where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey } }, data: { status: "COMPLETED", resourceType: "Dispute", resourceId: dispute.id, completedAt: now() } });
        return { dispute: serialize(dispute), duplicate: false };
      });
    } catch (error) { if (error instanceof ApiError) throw error; if (error?.code === "P2002") throw conflict("IDEMPOTENCY_CONFLICT"); throw unavailable(); }
  };

  const get = async ({ auth, disputeId, adminReview = false, requestId }) => {
    try {
      const prisma = await getClient();
      const dispute = await prisma.dispute.findUnique({ where: { id: disputeId }, include: { transaction: { select: { id: true, buyerId: true, sellerId: true } }, activities: { orderBy: { sequence: "asc" } }, evidence: { orderBy: { createdAt: "asc" } } } });
      if (!dispute) throw notFound();
      const user = await userAndRole(prisma, auth);
      if (adminReview) {
        if (user.role !== "ADMIN" || dispute.status !== "UNDER_REVIEW") throw notFound();
        await prisma.auditLog.create({ data: { actorUserId: auth.userId, action: "DISPUTE_REVIEW_VIEWED", entityType: "Dispute", entityId: dispute.id, requestId: requestId ?? null, metadata: { transactionId: dispute.transactionId } } });
      } else if (![dispute.transaction.buyerId, dispute.transaction.sellerId].includes(auth.userId) || user.role !== "USER") throw notFound();
      return serialize(dispute, dispute);
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const respond = async ({ auth, disputeId, message, requestId }) => {
    const prisma = await getClient();
    try { return await prisma.$transaction(async (tx) => {
      const before = await tx.dispute.findUnique({ where: { id: disputeId }, select: { transactionId: true } }); if (!before) throw notFound();
      await lockTransaction(tx, before.transactionId); await lockUser(tx, auth.userId); await lockDispute(tx, disputeId);
      const [transaction, dispute] = await Promise.all([tx.transaction.findUnique({ where: { id: before.transactionId } }), tx.dispute.findUnique({ where: { id: disputeId } })]);
      await userAndRole(tx, auth, "USER"); if (!transaction || !(await participantRole(tx, transaction, auth.userId))) throw notFound();
      if (!dispute || !["OPEN", "UNDER_REVIEW"].includes(dispute.status) || (dispute.responseDeadlineAt instanceof Date && dispute.responseDeadlineAt <= now())) throw conflict("DISPUTE_RESPONSE_CLOSED");
      const activity = await appendActivity(tx, dispute, auth.userId, "RESPONSE", { message });
      await audit(tx, auth.userId, "DISPUTE_RESPONSE_ADDED", dispute.id, transaction.id, requestId, { activityId: activity.id });
      await enqueueTransactionNotice(tx, { transactionId: transaction.id, template: "DISPUTE_RESPONSE", discriminator: activity.id });
      return { sequence: activity.sequence, type: activity.type, createdAt: activity.createdAt };
    }); } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const uploadEvidence = async ({ auth, disputeId, body, contentType, filename, category, requestId }) => {
    const bytes = Buffer.isBuffer(body) ? body : null;
    const sniffedType = bytes && detectType(bytes);
    if (!bytes || bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES || !allowedTypes.has(contentType) || sniffedType !== contentType || !evidenceCategorySchema.safeParse(category).success) throw new ApiError(400, "EVIDENCE_INVALID", "Evidence file is invalid");
    const safeName = filename ? win32.basename(basename(filename)).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || null : null;
    const storageObjectKey = `disputes/${randomUUID()}`;
    const sha256Hash = createHash("sha256").update(bytes).digest("hex");
    try { await storage.putObject({ key: storageObjectKey, body: bytes, contentType }); }
    catch { throw unavailable(); }
    try {
      const prisma = await getClient();
      const result = await prisma.$transaction(async (tx) => {
        const before = await tx.dispute.findUnique({ where: { id: disputeId }, select: { transactionId: true } }); if (!before) throw notFound();
        await lockTransaction(tx, before.transactionId); await lockUser(tx, auth.userId); await lockDispute(tx, disputeId);
        const [transaction, dispute] = await Promise.all([tx.transaction.findUnique({ where: { id: before.transactionId } }), tx.dispute.findUnique({ where: { id: disputeId } })]);
        await userAndRole(tx, auth, "USER"); if (!transaction || !(await participantRole(tx, transaction, auth.userId))) throw notFound();
        if (!dispute || !["OPEN", "UNDER_REVIEW"].includes(dispute.status) || (dispute.evidenceDeadlineAt instanceof Date && dispute.evidenceDeadlineAt <= now())) throw conflict("EVIDENCE_DEADLINE_PASSED");
        const evidence = await tx.evidence.create({ data: { disputeId, uploadedById: auth.userId, category, storageObjectKey, originalFilename: safeName, contentType, sizeBytes: BigInt(bytes.length), sha256Hash } });
        const activity = await appendActivity(tx, dispute, auth.userId, "EVIDENCE_ADDED", { metadata: { evidenceId: evidence.id, category, contentType, sizeBytes: bytes.length } });
        await audit(tx, auth.userId, "DISPUTE_EVIDENCE_ADDED", dispute.id, transaction.id, requestId, { evidenceId: evidence.id, category, sizeBytes: bytes.length });
        return { id: evidence.id, activitySequence: activity.sequence, category, contentType, sizeBytes: String(bytes.length), createdAt: evidence.createdAt };
      });
      return result;
    } catch (error) {
      await storage.deleteObject({ key: storageObjectKey }).catch(() => {});
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };

  const downloadEvidence = async ({ auth, evidenceId, adminReview = false, requestId }) => {
    try {
      const prisma = await getClient();
      const row = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        include: { dispute: { include: { transaction: { select: { id: true, buyerId: true, sellerId: true } } } } },
      });
      if (!row) throw notFound();
      const dispute = row.dispute; const transaction = dispute.transaction;
      const user = await prisma.user.findUnique({ where: { id: auth?.userId }, select: { id: true, role: true, status: true, authVersion: true } });
      if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion) throw notFound();
      const isParticipant = [transaction.buyerId, transaction.sellerId].includes(auth.userId);
      if (adminReview) {
        if (user.role !== "ADMIN" || dispute.status !== "UNDER_REVIEW") throw notFound();
        await prisma.auditLog.create({ data: { actorUserId: auth.userId, action: "DISPUTE_EVIDENCE_VIEWED_BY_REVIEWER", entityType: "Dispute", entityId: dispute.id, requestId: requestId ?? null, metadata: { evidenceId: row.id } } });
      } else if (!isParticipant || user.role !== "USER") throw notFound();
      const object = await storage.getObject({ key: row.storageObjectKey });
      const body = Buffer.isBuffer(object) ? object : Buffer.isBuffer(object?.body) ? object.body : null;
      if (!body || body.length !== Number(row.sizeBytes) || createHash("sha256").update(body).digest("hex") !== row.sha256Hash) throw unavailable();
      return { body, contentType: row.contentType, filename: row.originalFilename ?? "evidence" };
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const startReview = async ({ auth, disputeId, requestId }) => {
    requireTOTP(auth);
    const prisma = await getClient();
    try { return await prisma.$transaction(async (tx) => {
      const before = await tx.dispute.findUnique({ where: { id: disputeId }, select: { transactionId: true } }); if (!before) throw notFound();
      await lockTransaction(tx, before.transactionId); await lockUser(tx, auth.userId); await lockDispute(tx, disputeId);
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      await userAndRole(tx, auth, "ADMIN"); if (!dispute || dispute.status !== "OPEN") throw conflict("DISPUTE_NOT_OPEN");
      const changed = await tx.dispute.updateMany({ where: { id: disputeId, status: "OPEN", version: dispute.version }, data: { status: "UNDER_REVIEW", version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict("DISPUTE_VERSION_CONFLICT");
      const activity = await tx.disputeActivity.create({ data: { disputeId, sequence: dispute.version + 1, actorUserId: auth.userId, type: "REVIEW_STARTED" } });
      await audit(tx, auth.userId, "DISPUTE_REVIEW_STARTED", disputeId, dispute.transactionId, requestId, { activityId: activity.id });
      return { disputeId, status: "UNDER_REVIEW", version: dispute.version + 1 };
    }); } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const resolve = async ({ auth, disputeId, outcome, amountMinor, reason, requestId }) => {
    requireTOTP(auth);
    const prisma = await getClient();
    try { return await prisma.$transaction(async (tx) => {
      const before = await tx.dispute.findUnique({ where: { id: disputeId }, select: { transactionId: true } }); if (!before) throw notFound();
      await lockTransaction(tx, before.transactionId); await lockUser(tx, auth.userId); await lockDispute(tx, disputeId);
      const [dispute, transaction] = await Promise.all([tx.dispute.findUnique({ where: { id: disputeId } }), tx.transaction.findUnique({ where: { id: before.transactionId } })]);
      await userAndRole(tx, auth, "ADMIN");
      if (!dispute || dispute.status !== "UNDER_REVIEW" || transaction?.status !== "DISPUTED") throw conflict("DISPUTE_NOT_RESOLVABLE");
      const escrow = await tx.escrow.findUnique({ where: { transactionId_currency: { transactionId: transaction.id, currency: transaction.currency } } });
      if (!escrow || escrow.status !== "FUNDED" || escrow.balanceMinor <= 0n) throw conflict("ESCROW_NOT_FUNDED");
      let resolution; let resolutionAmountMinor = null; let transactionStatus = transaction.status;
      if (outcome === "FULL_REFUND") resolution = "REFUND";
      else if (outcome === "PARTIAL_REFUND") {
        resolutionAmountMinor = BigInt(amountMinor);
        if (resolutionAmountMinor <= 0n || resolutionAmountMinor >= escrow.balanceMinor) throw conflict("PARTIAL_REFUND_AMOUNT_INVALID");
        resolution = "PARTIAL_REFUND";
      } else if (outcome === "SELLER_RELEASE") { resolution = "SELLER_RELEASE"; transactionStatus = "DELIVERED"; }
      else throw new ApiError(400, "DISPUTE_RESOLUTION_INVALID", "Resolution is invalid");
      const changed = await tx.dispute.updateMany({ where: { id: disputeId, status: "UNDER_REVIEW", version: dispute.version }, data: { status: "RESOLVED", resolution, resolutionAmountMinor, resolvedById: auth.userId, resolvedAt: now(), version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict("DISPUTE_VERSION_CONFLICT");
      await tx.disputeActivity.create({ data: { disputeId, sequence: dispute.version + 1, actorUserId: auth.userId, type: "RESOLVED", message: reason, metadata: { outcome, ...(resolutionAmountMinor ? { amountMinor: resolutionAmountMinor.toString() } : {}) } } });
      if (transactionStatus !== transaction.status) {
        const updated = await tx.transaction.updateMany({ where: { id: transaction.id, status: "DISPUTED", version: transaction.version }, data: { status: transactionStatus, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
        await tx.transactionStatusHistory.create({ data: { transactionId: transaction.id, version: transaction.version + 1, previousStatus: "DISPUTED", newStatus: transactionStatus, actorUserId: auth.userId, reason: "DISPUTE_RESOLVED_SELLER_RELEASE" } });
        await enqueueBlockchainStatusCommitment(tx, { transactionId: transaction.id, version: transaction.version + 1, previousStatus: "DISPUTED", newStatus: transactionStatus });
      }
      await audit(tx, auth.userId, "DISPUTE_RESOLVED", disputeId, transaction.id, requestId, { outcome, ...(resolutionAmountMinor ? { amountMinor: resolutionAmountMinor.toString() } : {}) });
      await enqueueTransactionNotice(tx, { transactionId: transaction.id, template: "DISPUTE_RESOLVED", discriminator: `${disputeId}:${dispute.version + 1}` });
      return { disputeId, status: "RESOLVED", resolution, resolutionAmountMinor: resolutionAmountMinor?.toString() ?? null, transactionStatus };
    }); } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  return Object.freeze({ create, get, respond, uploadEvidence, downloadEvidence, startReview, resolve });
};
