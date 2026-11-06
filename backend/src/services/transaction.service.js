import { createHash, createHmac, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { PARTICIPANT_TRANSITIONS, serializeStatusHistory, serializeTermsVersion, serializeTransaction } from "../models/transaction.model.js";
import { enqueueTransactionNotice } from "./notification-event.service.js";
import { enqueueBlockchainStatusCommitment } from "./blockchain-event-hash.service.js";

const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const forbidden = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const conflict = (code = "TRANSACTION_CONFLICT") => new ApiError(409, code, "Transaction operation conflicts with current state");
const unavailable = () => new ApiError(503, "TRANSACTION_STORAGE_UNAVAILABLE", "Transaction service is temporarily unavailable");
const invitationInvalid = () => new ApiError(404, "INVITATION_INVALID", "Invitation is invalid or unavailable");
const transactionSelect = {
  id: true, buyerId: true, sellerId: true, status: true, amountMinor: true, currency: true,
  terms: true, version: true, createdAt: true, updatedAt: true,
};
const transactionWithParticipants = {
  ...transactionSelect,
  participants: { select: { userId: true, role: true, joinedAt: true }, orderBy: { role: "asc" } },
};
const historySelect = { version: true, previousStatus: true, newStatus: true, actorUserId: true, reason: true, createdAt: true };

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
};

export const createTransactionService = ({ getClient = getPrismaClient, now = () => new Date(), fingerprintSecret } = {}) => {
  const get = () => getClient();
  const makeFingerprint = (input) => createHmac("sha256", fingerprintSecret ?? getEnv().rateLimit.keySecret)
    .update(JSON.stringify(stableValue(input))).digest("hex");
  const lockUser = (tx, userId) => tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  const lockTransaction = (tx, transactionId) => tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE`;
  const recordAudit = (tx, actorUserId, action, transactionId, requestId, metadata) => tx.auditLog.create({
    data: { actorUserId, action, entityType: "Transaction", entityId: transactionId, requestId: requestId ?? null, metadata },
    select: { id: true },
  });
  const participantRole = async (tx, transaction, userId) => {
    const membership = await tx.transactionParticipant.findUnique({
      where: { transactionId_userId: { transactionId: transaction.id, userId } }, select: { role: true },
    });
    if (!membership) return null;
    const expected = membership.role === "BUYER" ? transaction.buyerId : membership.role === "SELLER" ? transaction.sellerId : null;
    return expected === userId ? membership.role : null;
  };
  const assertCurrentUser = async (tx, auth) => {
    const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { status: true, authVersion: true, role: true } });
    if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion) throw notFound();
    return user;
  };
  const currentTerms = (tx, transactionId) => tx.transactionTermsVersion.findFirst({
    where: { transactionId }, orderBy: { version: "desc" },
    include: { decisions: { select: { actorUserId: true, decision: true, createdAt: true }, orderBy: { createdAt: "asc" } } },
  });
  const termsAreAccepted = (version) => version && ["ACCEPTED", "LEGACY_ACCEPTED"].includes(version.status);
  const assertTermsMutable = async (tx, transactionId) => {
    const [attempt, escrow, dispute] = await Promise.all([
      tx.paymentAttempt.findFirst({ where: { transactionId }, select: { id: true } }),
      tx.escrow.findFirst({ where: { transactionId }, select: { id: true } }),
      tx.dispute.findFirst({ where: { transactionId }, select: { id: true } }),
    ]);
    if (attempt || escrow || dispute) throw conflict("TRANSACTION_TERMS_LOCKED");
  };
  const invitationHash = (token) => createHash("sha256").update(token, "utf8").digest("hex");
  const serializeInvitationResponse = (row) => ({ id: row.id, status: row.status, expiresAt: row.expiresAt });

  const resolveIdempotentCreate = async (prisma, scope, key, fingerprint) => {
    const operation = await prisma.idempotencyOperation.findUnique({ where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey: key } } });
    if (!operation) return null;
    if (operation.requestFingerprint !== fingerprint) throw conflict("IDEMPOTENCY_KEY_REUSED");
    if (operation.status !== "COMPLETED" || operation.resourceType !== "Transaction" || !operation.resourceId) throw conflict();
    const existing = await prisma.transaction.findUnique({ where: { id: operation.resourceId }, select: transactionWithParticipants });
    if (!existing || existing.buyerId !== scope.slice("TRANSACTION_CREATE:".length)) throw notFound();
    return serializeTransaction(existing);
  };

  const create = async ({ auth, input, idempotencyKey, requestId }) => {
    if (!auth || auth.role !== "USER" || auth.status !== "ACTIVE" || typeof auth.userId !== "string") throw forbidden();
    if (input.sellerId === auth.userId) throw new ApiError(400, "TRANSACTION_PARTICIPANTS_INVALID", "Buyer and seller must differ");
    const scope = `TRANSACTION_CREATE:${auth.userId}`;
    const fingerprint = makeFingerprint(input);
    const prisma = await get();
    try {
      const created = await prisma.$transaction(async (tx) => {
        for (const id of [auth.userId, input.sellerId].sort()) await lockUser(tx, id);
        const [buyer, seller] = await Promise.all([
          tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, status: true, role: true } }),
          tx.user.findUnique({ where: { id: input.sellerId }, select: { id: true, status: true, role: true } }),
        ]);
        if (!buyer || buyer.status !== "ACTIVE" || buyer.role !== "USER") throw forbidden();
        if (!seller || seller.status !== "ACTIVE" || seller.role !== "USER") throw notFound();

        await tx.idempotencyOperation.create({ data: {
          operationScope: scope, idempotencyKey, requestFingerprint: fingerprint, status: "IN_PROGRESS",
          expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000),
        } });
        const transaction = await tx.transaction.create({
          data: {
            buyerId: auth.userId, sellerId: input.sellerId, createdById: auth.userId,
            amountMinor: BigInt(input.amountMinor), currency: input.currency, terms: input.terms,
            status: "CREATED", version: 1,
          },
          select: transactionSelect,
        });
        await tx.transactionParticipant.createMany({ data: [
          { transactionId: transaction.id, userId: auth.userId, role: "BUYER" },
          { transactionId: transaction.id, userId: input.sellerId, role: "SELLER" },
        ] });
        await tx.transactionTermsVersion.create({ data: {
          transactionId: transaction.id, version: 1, proposedById: auth.userId,
          amountMinor: BigInt(input.amountMinor), currency: input.currency,
          details: input.terms, status: "PENDING",
        } });
        await tx.transactionStatusHistory.create({ data: {
          transactionId: transaction.id, version: 1, previousStatus: null, newStatus: "CREATED",
          actorUserId: auth.userId, reason: "TRANSACTION_CREATED",
        } });
        await enqueueBlockchainStatusCommitment(tx, { transactionId: transaction.id, version: 1, previousStatus: null, newStatus: "CREATED" });
        await recordAudit(tx, auth.userId, "TRANSACTION_CREATED", transaction.id, requestId, { status: "CREATED", version: 1, termsVersion: 1 });
        await recordAudit(tx, auth.userId, "TRANSACTION_TERMS_PROPOSED", transaction.id, requestId, { termsVersion: 1 });
        await enqueueTransactionNotice(tx, { transactionId: transaction.id, template: "TRANSACTION_CREATED", discriminator: "v1" });
        await tx.idempotencyOperation.update({
          where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey } },
          data: { status: "COMPLETED", resourceType: "Transaction", resourceId: transaction.id, completedAt: now() },
        });
        return tx.transaction.findUnique({ where: { id: transaction.id }, select: transactionWithParticipants });
      });
      return serializeTransaction(created);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002") {
        try {
          const replay = await resolveIdempotentCreate(prisma, scope, idempotencyKey, fingerprint);
          if (replay) return replay;
        } catch (resolveError) { if (resolveError instanceof ApiError) throw resolveError; }
        throw conflict();
      }
      throw unavailable();
    }
  };

  const listForUser = async ({ userId, status, cursor, limit }) => {
    const prisma = await get();
    try {
      const rows = await prisma.transaction.findMany({
        where: { ...(status ? { status } : {}), participants: { some: { userId } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: transactionWithParticipants,
      });
      const visible = rows.filter((row) => row.participants.some((participant) =>
        participant.userId === userId && ((participant.role === "BUYER" && row.buyerId === userId) || (participant.role === "SELLER" && row.sellerId === userId))));
      const hasMore = rows.length > limit;
      const page = visible.slice(0, limit);
      return { transactions: page.map(serializeTransaction), nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
    } catch { throw unavailable(); }
  };

  const getForParticipant = async ({ transactionId, userId }) => {
    const prisma = await get();
    try {
      const transaction = await prisma.transaction.findUnique({ where: { id: transactionId }, select: transactionWithParticipants });
      if (!transaction) throw notFound();
      const authorized = transaction.participants.some((participant) => participant.userId === userId
        && ((participant.role === "BUYER" && transaction.buyerId === userId) || (participant.role === "SELLER" && transaction.sellerId === userId)));
      if (!authorized) throw notFound();
      return serializeTransaction(transaction);
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const getHistory = async ({ transactionId, cursor, limit }) => {
    const prisma = await get();
    try {
      const rows = await prisma.transactionStatusHistory.findMany({
        where: { transactionId }, orderBy: { version: "desc" }, take: limit + 1,
        ...(cursor ? { cursor: { transactionId_version: { transactionId, version: Number(cursor) } }, skip: 1 } : {}), select: historySelect,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return { history: page.map(serializeStatusHistory), nextCursor: hasMore ? String(page.at(-1)?.version ?? "") : null };
    } catch { throw unavailable(); }
  };

  const getTerms = async ({ transactionId, userId }) => {
    const prisma = await get();
    try {
      const transaction = await prisma.transaction.findUnique({ where: { id: transactionId }, select: transactionSelect });
      if (!transaction || !(await participantRole(prisma, transaction, userId))) throw notFound();
      const versions = await prisma.transactionTermsVersion.findMany({
        where: { transactionId }, orderBy: { version: "desc" },
        include: { decisions: { select: { actorUserId: true, decision: true, createdAt: true }, orderBy: { createdAt: "asc" } } },
      });
      return { versions: versions.map(serializeTermsVersion) };
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const proposeTerms = async ({ auth, transactionId, input, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: transactionSelect });
        if (!transaction) throw notFound();
        await assertCurrentUser(tx, auth);
        const role = await participantRole(tx, transaction, auth.userId);
        if (!role) throw notFound();
        if (!["CREATED", "ACCEPTED"].includes(transaction.status)) throw conflict("TRANSACTION_TERMS_LOCKED");
        await assertTermsMutable(tx, transactionId);
        const prior = await tx.transactionTermsVersion.findFirst({ where: { transactionId }, orderBy: { version: "desc" }, select: { version: true } });
        const version = (prior?.version ?? 0) + 1;
        await tx.transactionTermsVersion.updateMany({ where: { transactionId, status: "PENDING" }, data: { status: "SUPERSEDED" } });
        const created = await tx.transactionTermsVersion.create({
          data: { transactionId, version, proposedById: auth.userId, amountMinor: BigInt(input.amountMinor), currency: input.currency, details: input.terms, status: "PENDING" },
          include: { decisions: true },
        });
        await recordAudit(tx, auth.userId, "TRANSACTION_TERMS_PROPOSED", transactionId, requestId, { termsVersion: version, participantRole: role });
        return serializeTermsVersion(created);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002" || error?.code === "P2034") throw conflict("TERMS_VERSION_CONFLICT");
      throw unavailable();
    }
  };

  const decideTerms = async ({ auth, transactionId, version, decision, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: transactionSelect });
        if (!transaction) throw notFound();
        await assertCurrentUser(tx, auth);
        const role = await participantRole(tx, transaction, auth.userId);
        if (!role) throw notFound();
        if (!["CREATED", "ACCEPTED"].includes(transaction.status)) throw conflict("TRANSACTION_TERMS_LOCKED");
        await assertTermsMutable(tx, transactionId);
        const latest = await currentTerms(tx, transactionId);
        if (!latest || latest.version !== version || latest.status !== "PENDING") throw conflict("TERMS_VERSION_CONFLICT");
        await tx.transactionTermsDecision.create({ data: { termsVersionId: latest.id, actorUserId: auth.userId, decision } });
        let resultingStatus = decision === "REJECTED" ? "REJECTED" : "PENDING";
        if (decision === "REJECTED") {
          await tx.transactionTermsVersion.update({ where: { id: latest.id }, data: { status: "REJECTED" } });
        } else {
          const decisions = await tx.transactionTermsDecision.findMany({ where: { termsVersionId: latest.id, decision: "ACCEPTED" }, select: { actorUserId: true } });
          const approved = new Set(decisions.map((row) => row.actorUserId));
          if (approved.has(transaction.buyerId) && approved.has(transaction.sellerId)) {
            await tx.transactionTermsVersion.update({ where: { id: latest.id }, data: { status: "ACCEPTED" } });
            await tx.transaction.update({ where: { id: transactionId }, data: { amountMinor: latest.amountMinor, currency: latest.currency, terms: latest.details } });
            resultingStatus = "ACCEPTED";
          }
        }
        await recordAudit(tx, auth.userId, `TRANSACTION_TERMS_${decision}`, transactionId, requestId, { termsVersion: version, participantRole: role });
        const result = await tx.transactionTermsVersion.findUnique({
          where: { id: latest.id },
          include: { decisions: { select: { actorUserId: true, decision: true, createdAt: true }, orderBy: { createdAt: "asc" } } },
        });
        return { ...serializeTermsVersion(result), status: resultingStatus };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002" || error?.code === "P2034") throw conflict("TERMS_VERSION_CONFLICT");
      throw unavailable();
    }
  };

  const createInvitation = async ({ auth, transactionId, inviteeId, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = invitationHash(token);
    const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000);
    const prisma = await get();
    try {
      const invitation = await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: transactionSelect });
        if (!transaction) throw notFound();
        await assertCurrentUser(tx, auth);
        const role = await participantRole(tx, transaction, auth.userId);
        if (role !== "BUYER" || inviteeId !== transaction.sellerId || transaction.status !== "CREATED") throw notFound();
        const invitee = await tx.user.findUnique({ where: { id: inviteeId }, select: { status: true, role: true } });
        if (!invitee || invitee.status !== "ACTIVE" || invitee.role !== "USER") throw notFound();
        const accepted = await tx.transactionInvitation.findFirst({ where: { transactionId, status: "ACCEPTED" }, select: { id: true } });
        if (accepted) throw conflict("INVITATION_ALREADY_ACCEPTED");
        await tx.transactionInvitation.updateMany({ where: { transactionId, status: "PENDING" }, data: { status: "REVOKED", revokedAt: now() } });
        const created = await tx.transactionInvitation.create({ data: { transactionId, inviterId: auth.userId, inviteeId, tokenHash, expiresAt } });
        await recordAudit(tx, auth.userId, "TRANSACTION_INVITATION_CREATED", transactionId, requestId, { invitationId: created.id, inviteeId });
        return created;
      });
      // The opaque token exists only in this dedicated issuance response; all
      // persisted records, later reads and audit data contain only its hash/id.
      return { invitation: serializeInvitationResponse(invitation), invitationToken: token };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2034") throw conflict("INVITATION_CONFLICT");
      throw unavailable();
    }
  };

  const respondToInvitation = async ({ auth, token, expectedVersion, decision, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    const prisma = await get();
    try {
      const tokenHash = invitationHash(token);
      const locator = await prisma.transactionInvitation.findUnique({ where: { tokenHash }, select: { id: true, transactionId: true } });
      if (!locator) throw invitationInvalid();
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, locator.transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: locator.transactionId }, select: transactionSelect });
        const invitation = await tx.transactionInvitation.findUnique({ where: { id: locator.id } });
        if (!transaction || !invitation || invitation.inviteeId !== auth.userId || invitation.status !== "PENDING" || invitation.expiresAt <= now() || transaction.status !== "CREATED") throw invitationInvalid();
        const currentUser = await assertCurrentUser(tx, auth);
        if (currentUser.role !== "USER") throw invitationInvalid();
        if (transaction.version !== expectedVersion) throw conflict("TRANSACTION_VERSION_CONFLICT");
        if (await participantRole(tx, transaction, auth.userId) !== "SELLER") throw invitationInvalid();
        const stamp = now();
        const invitationUpdate = await tx.transactionInvitation.updateMany({
          where: { id: invitation.id, status: "PENDING", tokenHash, expiresAt: { gt: stamp } },
          data: { status: decision, ...(decision === "ACCEPTED" ? { acceptedAt: stamp } : { rejectedAt: stamp }) },
        });
        if (invitationUpdate.count !== 1) throw invitationInvalid();
        await recordAudit(tx, auth.userId, `TRANSACTION_INVITATION_${decision}`, transaction.id, requestId, { invitationId: invitation.id });
        await enqueueTransactionNotice(tx, { transactionId: transaction.id, template: "TRANSACTION_STATUS_CHANGED", discriminator: `invitation:${decision}:${expectedVersion}` });
        if (decision === "REJECTED") {
          const transitionUpdate = await tx.transaction.updateMany({
            where: { id: transaction.id, status: "CREATED", version: expectedVersion },
            data: { status: "REJECTED", version: { increment: 1 } },
          });
          if (transitionUpdate.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
          await tx.transactionStatusHistory.create({ data: {
            transactionId: transaction.id, version: expectedVersion + 1, previousStatus: "CREATED", newStatus: "REJECTED",
            actorUserId: auth.userId, reason: "SELLER_DECLINED",
          } });
          await enqueueBlockchainStatusCommitment(tx, { transactionId: transaction.id, version: expectedVersion + 1, previousStatus: "CREATED", newStatus: "REJECTED" });
          await tx.transactionInvitation.updateMany({ where: { transactionId: transaction.id, status: "PENDING" }, data: { status: "REVOKED", revokedAt: stamp } });
          await recordAudit(tx, auth.userId, "TRANSACTION_STATUS_CHANGED", transaction.id, requestId, { previousStatus: "CREATED", newStatus: "REJECTED", version: expectedVersion + 1, participantRole: "SELLER" });
        }
        const result = decision === "REJECTED"
          ? await tx.transaction.findUnique({ where: { id: transaction.id }, select: transactionWithParticipants })
          : transaction;
        return { invitation: serializeInvitationResponse({ ...invitation, status: decision, acceptedAt: decision === "ACCEPTED" ? stamp : null, rejectedAt: decision === "REJECTED" ? stamp : null }), transaction: serializeTransaction(result) };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2034") throw conflict("TRANSACTION_VERSION_CONFLICT");
      throw unavailable();
    }
  };

  const transition = async ({ auth, transactionId, status, expectedVersion, requestId }) => {
    if (!auth || typeof auth.userId !== "string" || !Number.isSafeInteger(auth.authVersion)) throw forbidden();
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: transactionSelect });
        if (!transaction) throw notFound();
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion) throw notFound();
        const role = await participantRole(tx, transaction, auth.userId);
        if (!role) throw notFound();
        const rule = PARTICIPANT_TRANSITIONS[transaction.status]?.[status];
        if (!rule || rule.role !== role) throw conflict("TRANSACTION_TRANSITION_NOT_ALLOWED");
        if (transaction.version !== expectedVersion) throw conflict("TRANSACTION_VERSION_CONFLICT");
        if (status === "ACCEPTED") {
          const [termsVersion, acceptedInvitation] = await Promise.all([
            currentTerms(tx, transactionId),
            tx.transactionInvitation.findFirst({ where: { transactionId, inviteeId: transaction.sellerId, status: "ACCEPTED", acceptedAt: { not: null } }, select: { id: true } }),
          ]);
          const decisionActors = new Set((termsVersion?.decisions ?? []).filter((row) => row.decision === "ACCEPTED").map((row) => row.actorUserId));
          const legacyAccepted = termsVersion?.status === "LEGACY_ACCEPTED";
          if (!termsAreAccepted(termsVersion) || (!legacyAccepted && (!decisionActors.has(transaction.buyerId) || !decisionActors.has(transaction.sellerId)))) throw conflict("TERMS_ACCEPTANCE_REQUIRED");
          if (!acceptedInvitation) throw conflict("INVITATION_ACCEPTANCE_REQUIRED");
        }
        if (status === "AWAITING_PAYMENT") {
          const termsVersion = await currentTerms(tx, transactionId);
          if (!termsAreAccepted(termsVersion)) throw conflict("TERMS_ACCEPTANCE_REQUIRED");
        }
        if (transaction.status === "AWAITING_PAYMENT" && status === "CANCELLED") {
          // Payment writers and this cancellation path serialize on the parent
          // transaction row. A label alone is not evidence: every attempt must
          // have a processed, provider-verified terminal no-capture event, and
          // any quarantined/failed event keeps the outcome unresolved.
          const attempts = await tx.paymentAttempt.findMany({
            where: { transactionId },
            select: { id: true, status: true, webhookEvents: { select: { status: true, eventData: true } } },
          });
          const unresolved = attempts.some((attempt) => {
            const verifiedNoCapture = attempt.webhookEvents.some((event) => event.status === "PROCESSED"
              && event.eventData?.final === true && event.eventData?.noCapture === true && event.eventData?.outcome === attempt.status);
            const eventConflict = attempt.webhookEvents.some((event) => ["FAILED", "PROCESSING"].includes(event.status));
            return !["FAILED", "CANCELLED"].includes(attempt.status) || !verifiedNoCapture || eventConflict;
          });
          if (unresolved) throw conflict("PAYMENT_OUTCOME_UNVERIFIED");
        }
        const nextVersion = transaction.version + 1;
        const updated = await tx.transaction.updateMany({
          where: { id: transactionId, version: expectedVersion, status: transaction.status },
          data: { status, version: { increment: 1 } },
        });
        if (updated.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
        await tx.transactionStatusHistory.create({ data: {
          transactionId, version: nextVersion, previousStatus: transaction.status, newStatus: status,
          actorUserId: auth.userId, reason: rule.reasonCode,
        } });
        await enqueueBlockchainStatusCommitment(tx, { transactionId, version: nextVersion, previousStatus: transaction.status, newStatus: status });
        await tx.transactionInvitation.updateMany({ where: { transactionId, status: "PENDING" }, data: { status: "REVOKED", revokedAt: now() } });
        await tx.transactionTermsVersion.updateMany({ where: { transactionId, status: "PENDING" }, data: { status: "SUPERSEDED" } });
        await recordAudit(tx, auth.userId, "TRANSACTION_STATUS_CHANGED", transactionId, requestId, {
          previousStatus: transaction.status, newStatus: status, version: nextVersion, participantRole: role,
        });
        await enqueueTransactionNotice(tx, { transactionId, template: "TRANSACTION_STATUS_CHANGED", discriminator: `v${nextVersion}:${status}` });
        const result = await tx.transaction.findUnique({ where: { id: transactionId }, select: transactionWithParticipants });
        return serializeTransaction(result);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002" || error?.code === "P2034") throw conflict("TRANSACTION_VERSION_CONFLICT");
      throw unavailable();
    }
  };

  return Object.freeze({ create, listForUser, getForParticipant, getHistory, getTerms, proposeTerms, decideTerms, createInvitation, respondToInvitation, transition });
};
