import { createHash, randomUUID } from "node:crypto";
import { basename, win32 } from "node:path";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { createUnavailableEvidenceStorage } from "./evidence-storage.service.js";
import { enqueueTransactionNotice } from "./notification-event.service.js";
import { enqueueBlockchainStatusCommitment } from "./blockchain-event-hash.service.js";

const fail = (status, code, message) => new ApiError(status, code, message);
const unavailable = () => fail(503, "TRANSACTION_STORAGE_UNAVAILABLE", "Transaction service is temporarily unavailable");
const conflict = (code) => fail(409, code, "Transaction operation conflicts with current state");
const notFound = () => fail(404, "RESOURCE_NOT_FOUND", "Resource not found");
const forbidden = () => fail(403, "FORBIDDEN", "Access is not permitted");
const allowedTypes = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const allowedCategories = new Set(["DELIVERY", "WORK_PROGRESS", "COMMUNICATION", "OTHER"]);
const detectType = (b) => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
  : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
    : b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
      : b.toString("ascii", 0, 5) === "%PDF-" ? "application/pdf" : null;

export const createTransactionDeliveryService = ({ getClient = getPrismaClient, storage = createUnavailableEvidenceStorage(), now = () => new Date() } = {}) => {
  const lockTransaction = (tx, id) => tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const audit = (tx, auth, action, transactionId, requestId, metadata) => tx.auditLog.create({ data: {
    actorUserId: auth.userId, action, entityType: "Transaction", entityId: transactionId,
    requestId: requestId ?? null, metadata,
  } });
  const authorized = async (tx, auth, transactionId, role) => {
    const [transaction, user, participant] = await Promise.all([
      tx.transaction.findUnique({ where: { id: transactionId } }),
      tx.user.findUnique({ where: { id: auth?.userId }, select: { status: true, authVersion: true, role: true } }),
      tx.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId, userId: auth?.userId } } }),
    ]);
    if (!transaction) throw notFound();
    if (!user || user.status !== "ACTIVE" || user.authVersion !== auth?.authVersion) throw notFound();
    if (user.role !== "USER" || participant?.role !== role || transaction[role === "BUYER" ? "buyerId" : "sellerId"] !== auth.userId) throw notFound();
    return transaction;
  };
  const writeTransition = async (tx, transaction, next, actor, reason, requestId) => {
    const updated = await tx.transaction.updateMany({ where: { id: transaction.id, status: transaction.status, version: transaction.version }, data: { status: next, version: { increment: 1 } } });
    if (updated.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
    await tx.transactionStatusHistory.create({ data: { transactionId: transaction.id, version: transaction.version + 1, previousStatus: transaction.status, newStatus: next, actorUserId: actor, reason } });
    await enqueueBlockchainStatusCommitment(tx, { transactionId: transaction.id, version: transaction.version + 1, previousStatus: transaction.status, newStatus: next });
    await audit(tx, { userId: actor }, "TRANSACTION_STATUS_CHANGED", transaction.id, requestId, { previousStatus: transaction.status, newStatus: next, version: transaction.version + 1 });
  };

  const startWork = async ({ auth, transactionId, expectedVersion, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    try { return await (await getClient()).$transaction(async (tx) => {
      await lockTransaction(tx, transactionId);
      const transaction = await authorized(tx, auth, transactionId, "SELLER");
      if (transaction.version !== expectedVersion) throw conflict("TRANSACTION_VERSION_CONFLICT");
      if (transaction.status !== "FUNDED") throw conflict("TRANSACTION_TRANSITION_NOT_ALLOWED");
      const escrow = await tx.escrow.findUnique({ where: { transactionId_currency: { transactionId, currency: transaction.currency } } });
      if (!escrow || escrow.status !== "FUNDED" || escrow.balanceMinor <= 0n) throw conflict("ESCROW_NOT_FUNDED");
      await writeTransition(tx, transaction, "IN_PROGRESS", auth.userId, "SELLER_WORK_STARTED", requestId);
      return { transactionId, status: "IN_PROGRESS", version: transaction.version + 1 };
    }); } catch (e) { if (e instanceof ApiError) throw e; throw unavailable(); }
  };

  const submitDelivery = async ({ auth, transactionId, expectedVersion, description, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    try { return await (await getClient()).$transaction(async (tx) => {
      await lockTransaction(tx, transactionId);
      const transaction = await authorized(tx, auth, transactionId, "SELLER");
      if (transaction.version !== expectedVersion) throw conflict("TRANSACTION_VERSION_CONFLICT");
      if (transaction.status !== "IN_PROGRESS") throw conflict("TRANSACTION_TRANSITION_NOT_ALLOWED");
      const latest = await tx.transactionDelivery.findFirst({ where: { transactionId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      const delivery = await tx.transactionDelivery.create({ data: { transactionId, sequence: (latest?.sequence ?? 0) + 1, submittedById: auth.userId, description } });
      await writeTransition(tx, transaction, "DELIVERED", auth.userId, "SELLER_DELIVERY_SUBMITTED", requestId);
      await audit(tx, auth, "TRANSACTION_DELIVERY_SUBMITTED", transactionId, requestId, { deliveryId: delivery.id, sequence: delivery.sequence });
      await enqueueTransactionNotice(tx, { transactionId, template: "TRANSACTION_STATUS_CHANGED", discriminator: `delivery:${delivery.sequence}` });
      return { id: delivery.id, sequence: delivery.sequence, description: delivery.description, createdAt: delivery.createdAt, decision: null, evidence: [] };
    }); } catch (e) { if (e instanceof ApiError) throw e; if (e?.code === "P2002" || e?.code === "P2034") throw conflict("TRANSACTION_VERSION_CONFLICT"); throw unavailable(); }
  };

  const decideDelivery = async ({ auth, transactionId, deliveryId, expectedVersion, decision, reason, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    try { return await (await getClient()).$transaction(async (tx) => {
      await lockTransaction(tx, transactionId);
      const transaction = await authorized(tx, auth, transactionId, "BUYER");
      if (transaction.version !== expectedVersion) throw conflict("TRANSACTION_VERSION_CONFLICT");
      if (transaction.status !== "DELIVERED") throw conflict("DELIVERY_NOT_PENDING_REVIEW");
      const delivery = await tx.transactionDelivery.findUnique({ where: { id: deliveryId }, include: { evidence: { select: { id: true } } } });
      if (!delivery || delivery.transactionId !== transactionId) throw notFound();
      if (delivery.decision) throw conflict("DELIVERY_ALREADY_DECIDED");
      const terms = await tx.transactionTermsVersion.findFirst({ where: { transactionId, status: { in: ["ACCEPTED", "LEGACY_ACCEPTED"] } }, orderBy: { version: "desc" }, select: { details: true } });
      const requirements = terms?.details?.evidenceRequirements ?? transaction.terms?.evidenceRequirements;
      const required = Array.isArray(requirements) ? requirements.length : 0;
      if (decision === "ACCEPTED" && delivery.evidence.length < required) throw conflict("DELIVERY_EVIDENCE_REQUIRED");
      await tx.deliveryDecision.create({ data: { deliveryId, actorUserId: auth.userId, decision, reason: reason ?? null } });
      if (decision === "CHANGES_REQUESTED") await writeTransition(tx, transaction, "IN_PROGRESS", auth.userId, "BUYER_REQUESTED_DELIVERY_CHANGES", requestId);
      await audit(tx, auth, "TRANSACTION_DELIVERY_DECIDED", transactionId, requestId, { deliveryId, decision });
      await enqueueTransactionNotice(tx, { transactionId, template: "TRANSACTION_STATUS_CHANGED", discriminator: `delivery-decision:${deliveryId}:${decision}` });
      return { deliveryId, decision, reason: reason ?? null, createdAt: now(), transactionStatus: decision === "CHANGES_REQUESTED" ? "IN_PROGRESS" : "DELIVERED", version: decision === "CHANGES_REQUESTED" ? transaction.version + 1 : transaction.version };
    }); } catch (e) { if (e instanceof ApiError) throw e; if (e?.code === "P2002" || e?.code === "P2034") throw conflict("DELIVERY_ALREADY_DECIDED"); throw unavailable(); }
  };

  const uploadEvidence = async ({ auth, transactionId, deliveryId, body, contentType, filename, category, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > 10 * 1024 * 1024 || !allowedTypes.has(contentType) || detectType(body) !== contentType || !allowedCategories.has(category)) throw fail(400, "EVIDENCE_INVALID", "Evidence file is invalid");
    const safeFilename = typeof filename === "string" ? basename(win32.basename(filename)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 255) || null : null;
    const key = `transaction-deliveries/${randomUUID()}`;
    try { await storage.putObject({ key, body, contentType }); } catch { throw unavailable(); }
    try {
      return await (await getClient()).$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await authorized(tx, auth, transactionId, "SELLER");
        const delivery = await tx.transactionDelivery.findUnique({ where: { id: deliveryId }, include: { decision: { select: { id: true } } } });
        if (!delivery || delivery.transactionId !== transactionId || delivery.decision || !["DELIVERED", "IN_PROGRESS"].includes(transaction.status)) throw notFound();
        const evidence = await tx.evidence.create({ data: { transactionDeliveryId: deliveryId, uploadedById: auth.userId, category, storageObjectKey: key, originalFilename: safeFilename, contentType, sizeBytes: BigInt(body.length), sha256Hash: createHash("sha256").update(body).digest("hex") } });
        await audit(tx, auth, "TRANSACTION_DELIVERY_EVIDENCE_ADDED", transactionId, requestId, { deliveryId, evidenceId: evidence.id, category, contentType, sizeBytes: body.length });
        return { id: evidence.id, deliveryId, category, contentType, sizeBytes: body.length, createdAt: evidence.createdAt };
      });
    } catch (e) { await storage.deleteObject({ key }).catch(() => {}); if (e instanceof ApiError) throw e; throw unavailable(); }
  };

  const getHistory = async ({ auth, transactionId }) => {
    try {
      const prisma = await getClient();
      const [transaction, user, participant] = await Promise.all([
        prisma.transaction.findUnique({ where: { id: transactionId }, select: { buyerId: true, sellerId: true } }),
        prisma.user.findUnique({ where: { id: auth?.userId }, select: { status: true, authVersion: true, role: true } }),
        prisma.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId, userId: auth?.userId } } }),
      ]);
      if (!transaction || !user || user.status !== "ACTIVE" || user.authVersion !== auth?.authVersion || user.role !== "USER" || !participant || ![transaction.buyerId, transaction.sellerId].includes(auth.userId)) throw notFound();
      return prisma.transactionDelivery.findMany({ where: { transactionId }, orderBy: { sequence: "asc" }, include: { decision: { select: { decision: true, reason: true, createdAt: true } }, evidence: { select: { id: true, category: true, contentType: true, sizeBytes: true, createdAt: true } } } }).then((rows) => rows.map((row) => ({ id: row.id, sequence: row.sequence, description: row.description, submittedById: row.submittedById, createdAt: row.createdAt, decision: row.decision, evidence: row.evidence.map((item) => ({ id: item.id, category: item.category, contentType: item.contentType, sizeBytes: item.sizeBytes.toString(), createdAt: item.createdAt })) })));
    } catch (e) { if (e instanceof ApiError) throw e; throw unavailable(); }
  };

  const downloadEvidence = async ({ auth, evidenceId, requestId }) => {
    try {
      const prisma = await getClient();
      const row = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        include: { delivery: { include: { transaction: { select: { id: true, buyerId: true, sellerId: true } } } } },
      });
      const user = await prisma.user.findUnique({ where: { id: auth?.userId }, select: { status: true, authVersion: true, role: true } });
      if (!row?.delivery || !user || user.status !== "ACTIVE" || user.authVersion !== auth?.authVersion || user.role !== "USER" || ![row.delivery.transaction.buyerId, row.delivery.transaction.sellerId].includes(auth.userId)) throw notFound();
      await prisma.auditLog.create({ data: { actorUserId: auth.userId, action: "TRANSACTION_DELIVERY_EVIDENCE_VIEWED", entityType: "Transaction", entityId: row.delivery.transaction.id, requestId: requestId ?? null, metadata: { deliveryId: row.transactionDeliveryId, evidenceId: row.id } } });
      const value = await storage.getObject({ key: row.storageObjectKey });
      const body = Buffer.isBuffer(value) ? value : Buffer.isBuffer(value?.body) ? value.body : null;
      if (!body || body.length !== Number(row.sizeBytes) || createHash("sha256").update(body).digest("hex") !== row.sha256Hash) throw unavailable();
      return { body, contentType: row.contentType, filename: row.originalFilename ?? "evidence" };
    } catch (e) { if (e instanceof ApiError) throw e; throw unavailable(); }
  };

  return Object.freeze({ startWork, submitDelivery, decideDelivery, uploadEvidence, getHistory, downloadEvidence });
};
