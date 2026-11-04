import { createHash, randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

const unavailable = () => new ApiError(503, "ESCROW_UNAVAILABLE", "Escrow service is temporarily unavailable");
const denied = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const conflict = (code = "ESCROW_CONFLICT") => new ApiError(409, code, "Escrow operation conflicts with current state");
const safeEscrow = (row) => ({ id: row.id, transactionId: row.transactionId, status: row.status, balanceMinor: row.balanceMinor.toString(), currency: row.currency.trim() });

const lockTransaction = (tx, id) => tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${id}::uuid FOR UPDATE`;
const audit = (tx, actorUserId, action, transactionId, requestId, metadata) => tx.auditLog.create({ data: { actorUserId, action, entityType: "TRANSACTION", entityId: transactionId, requestId, metadata } });

const account = async (tx, { transactionId, currency, escrowId = null, accountCode, accountType }) => tx.ledgerAccount.upsert({
  where: { transactionId_accountCode_currency: { transactionId, accountCode, currency } },
  create: { transactionId, currency, escrowId, accountCode, accountType },
  update: {},
});

const postJournal = async (tx, { transactionId, currency, amountMinor, operationKey, debit, credit }) => {
  const amount = BigInt(amountMinor);
  if (amount <= 0n) throw conflict("INVALID_LEDGER_AMOUNT");
  const journal = await tx.ledgerJournal.create({ data: { transactionId, currency, operationId: operationKey } });
  await tx.ledgerEntry.createMany({ data: [
    { journalId: journal.id, transactionId, currency, accountId: debit.id, amountMinor: amount, direction: "DEBIT" },
    { journalId: journal.id, transactionId, currency, accountId: credit.id, amountMinor: amount, direction: "CREDIT" },
  ] });
  const debitTotal = amount;
  const creditTotal = amount;
  if (debitTotal !== creditTotal) throw conflict("UNBALANCED_JOURNAL");
  return journal;
};

export const createEscrowService = ({ getClient = getPrismaClient, now = () => new Date(), releaseExecutor, refundExecutor } = {}) => {
  // Called only by the verified payment service while it holds the transaction row lock.
  const recordVerifiedFunding = async ({ tx, paymentAttempt, actorUserId = null, requestId = null }) => {
    try {
      if (!tx || !paymentAttempt || paymentAttempt.status !== "CAPTURED" || paymentAttempt.amountMinor <= 0n) throw conflict("CAPTURE_NOT_VERIFIED");
      const transaction = await tx.transaction.findUnique({ where: { id: paymentAttempt.transactionId } });
      if (!transaction || transaction.amountMinor !== paymentAttempt.amountMinor || transaction.currency.trim() !== paymentAttempt.currency.trim()) throw conflict("PAYMENT_EVENT_MISMATCH");
      const operationKey = `FUNDING:${paymentAttempt.id}`;
      const existing = await tx.escrowOperation.findUnique({ where: { operationKey } });
      if (existing) return { funded: true, duplicate: true };
      if (transaction.status !== "AWAITING_PAYMENT") throw conflict("FUNDING_STATE_MISMATCH");
      const escrow = await tx.escrow.upsert({
        where: { transactionId_currency: { transactionId: transaction.id, currency: transaction.currency } },
        create: { transactionId: transaction.id, currency: transaction.currency, status: "UNFUNDED", balanceMinor: 0n },
        update: {},
      });
      if (escrow.status !== "UNFUNDED" || escrow.balanceMinor !== 0n) throw conflict("ESCROW_ALREADY_FUNDED");
      const clearing = await account(tx, { transactionId: transaction.id, currency: transaction.currency, accountCode: "PROVIDER_CLEARING", accountType: "ASSET" });
      const liability = await account(tx, { transactionId: transaction.id, currency: transaction.currency, escrowId: escrow.id, accountCode: "ESCROW_LIABILITY", accountType: "LIABILITY" });
      const journal = await postJournal(tx, { transactionId: transaction.id, currency: transaction.currency, amountMinor: paymentAttempt.amountMinor, operationKey, debit: clearing, credit: liability });
      await tx.escrowOperation.create({ data: {
        transactionId: transaction.id, escrowId: escrow.id, paymentAttemptId: paymentAttempt.id, ledgerJournalId: journal.id,
        actorUserId, type: "FUNDING", status: "SUCCEEDED", idempotencyKey: operationKey, operationKey,
        provider: paymentAttempt.provider, providerReference: paymentAttempt.providerReference,
        amountMinor: paymentAttempt.amountMinor, currency: transaction.currency, reasonCode: "VERIFIED_PROVIDER_CAPTURE", completedAt: now(),
      } });
      const changed = await tx.transaction.updateMany({ where: { id: transaction.id, status: "AWAITING_PAYMENT", version: transaction.version }, data: { status: "FUNDED", version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
      await tx.escrow.update({ where: { id: escrow.id }, data: { status: "FUNDED", balanceMinor: paymentAttempt.amountMinor, fundedAt: now() } });
      await tx.transactionStatusHistory.create({ data: { transactionId: transaction.id, version: transaction.version + 1, previousStatus: "AWAITING_PAYMENT", newStatus: "FUNDED", actorUserId, reason: "VERIFIED_PAYMENT_FUNDING" } });
      await audit(tx, actorUserId, "ESCROW_FUNDED", transaction.id, requestId, { escrowId: escrow.id, paymentAttemptId: paymentAttempt.id, ledgerJournalId: journal.id, amountMinor: paymentAttempt.amountMinor.toString(), currency: transaction.currency.trim() });
      return { funded: true, duplicate: false };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };

  const authorize = async ({ auth, transactionId, type, idempotencyKey, requestId, reasonCode }) => {
    const prisma = await getClient();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId } });
        if (!transaction) throw denied();
        if (!auth || typeof auth.userId !== "string" || typeof auth.sessionId !== "string" || auth.assuranceLevel !== "TOTP_VERIFIED" || auth.mfaEnabled !== true) throw denied();
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${auth.userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "refresh_tokens" WHERE "id" = ${auth.sessionId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "user_mfa" WHERE "user_id" = ${auth.userId}::uuid FOR UPDATE`;
        // Keep transaction-client operations sequential: PostgreSQL interactive
        // transactions share one connection and the preceding lock order is security-critical.
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, role: true, status: true, authVersion: true } });
        const participant = await tx.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId, userId: auth.userId } } });
        const escrow = await tx.escrow.findUnique({ where: { transactionId_currency: { transactionId, currency: transaction.currency } } });
        const session = await tx.refreshToken.findUnique({ where: { id: auth.sessionId }, select: { userId: true, authVersion: true, assuranceLevel: true, createdAt: true, revokedAt: true, expiresAt: true, mfaVerifiedAt: true } });
        const mfa = await tx.userMfa.findUnique({ where: { userId: auth.userId }, select: { enrollmentStatus: true, enabledAt: true } });
        if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion || user.role !== auth.role
          || !session || session.userId !== auth.userId || session.authVersion !== auth.authVersion || session.revokedAt
          || !(session.expiresAt instanceof Date) || session.expiresAt <= now() || session.assuranceLevel !== "TOTP_VERIFIED"
          || !(session.createdAt instanceof Date) || !(session.mfaVerifiedAt instanceof Date) || !mfa || mfa.enrollmentStatus !== "ENABLED" || !(mfa.enabledAt instanceof Date)
          || session.createdAt < mfa.enabledAt
          || mfa.enabledAt > session.mfaVerifiedAt) throw denied();
        const isBuyer = participant?.role === "BUYER" && transaction.buyerId === auth.userId && user.role === "USER";
        const isAdminRefund = type === "REFUND" && user.role === "ADMIN";
        if (!(type === "RELEASE" ? isBuyer : isAdminRefund)) throw denied();
        if (type === "RELEASE" && reasonCode !== "BUYER_ACCEPTED_DELIVERY") throw denied();
        if (type === "REFUND" && reasonCode !== "ADMIN_RESOLVED_REFUND") throw denied();
        const scopedIdempotencyKey = createHash("sha256").update(`${type}\0${auth.userId}\0${idempotencyKey}`).digest("hex");
        const opKey = `${type}:${transactionId}:${scopedIdempotencyKey}`;
        const prior = await tx.escrowOperation.findUnique({ where: { operationKey: opKey } });
        if (prior) return { operationId: prior.id, status: prior.status, duplicate: true };
        if (!escrow || escrow.status !== "FUNDED" || escrow.balanceMinor <= 0n) throw conflict("ESCROW_NOT_FUNDED");
        if (type === "RELEASE") {
          if (transaction.status !== "DELIVERED") throw conflict("RELEASE_NOT_ELIGIBLE");
          const activeDispute = await tx.dispute.findFirst({ where: { transactionId, status: { in: ["OPEN", "UNDER_REVIEW"] } }, select: { id: true } });
          if (activeDispute) throw conflict("DISPUTE_BLOCKS_RELEASE");
        } else {
          if (transaction.status !== "DISPUTED") throw conflict("REFUND_NOT_ELIGIBLE");
          const activeDispute = await tx.dispute.findFirst({ where: { transactionId, status: { in: ["OPEN", "UNDER_REVIEW"] } }, select: { id: true } });
          if (activeDispute) throw conflict("DISPUTE_BLOCKS_REFUND");
          const resolvedRefund = await tx.dispute.findFirst({ where: { transactionId, status: "RESOLVED", resolution: "REFUND" }, select: { id: true } });
          if (!resolvedRefund) throw conflict("REFUND_NOT_AUTHORIZED");
        }
        const nextTransactionStatus = type === "RELEASE" ? "RELEASE_PENDING" : "REFUND_PENDING";
        const nextEscrowStatus = type === "RELEASE" ? "RELEASE_PENDING" : "REFUND_PENDING";
        const changed = await tx.transaction.updateMany({ where: { id: transactionId, status: transaction.status, version: transaction.version }, data: { status: nextTransactionStatus, version: { increment: 1 } } });
        if (changed.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
        const operation = await tx.escrowOperation.create({ data: {
          transactionId, escrowId: escrow.id, actorUserId: auth.userId, type, status: "PENDING", idempotencyKey: scopedIdempotencyKey,
          operationKey: opKey, amountMinor: escrow.balanceMinor, currency: escrow.currency,
          reasonCode, authorizedAt: now(),
        } });
        await tx.escrow.update({ where: { id: escrow.id }, data: { status: nextEscrowStatus } });
        await tx.transactionStatusHistory.create({ data: { transactionId, version: transaction.version + 1, previousStatus: transaction.status, newStatus: nextTransactionStatus, actorUserId: auth.userId, reason: reasonCode } });
        await audit(tx, auth.userId, `ESCROW_${type}_AUTHORIZED`, transactionId, requestId, { escrowId: escrow.id, operationId: operation.id, amountMinor: escrow.balanceMinor.toString(), currency: escrow.currency.trim(), reasonCode });
        await tx.outboxEvent.create({ data: { eventKey: `ESCROW_OPERATION:${operation.id}`, eventType: `ESCROW_${type}_AUTHORIZED`, aggregateType: "TRANSACTION", aggregateId: transactionId, transactionId, payload: { operationId: operation.id, type, amountMinor: escrow.balanceMinor.toString(), currency: escrow.currency.trim() }, status: "PENDING", attemptCount: 0 } });
        return { operationId: operation.id, status: operation.status, duplicate: false };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002") throw conflict("IDEMPOTENCY_CONFLICT");
      throw unavailable();
    }
  };

  const authorizeRelease = (input) => authorize({ ...input, type: "RELEASE" });
  const authorizeRefund = (input) => authorize({ ...input, type: "REFUND" });

  // Provider calls occur outside DB transactions. Only an explicitly verified,
  // amount/reference-matched result may post a journal and finalize state.
  const executeAuthorizedOperation = async ({ operationId }) => {
    const prisma = await getClient();
    const operation = await prisma.escrowOperation.findUnique({ where: { id: operationId }, include: { transaction: true } });
    if (!operation || operation.type === "FUNDING" || operation.status !== "PENDING") throw denied();
    const executor = operation.type === "RELEASE" ? releaseExecutor : refundExecutor;
    if (typeof executor !== "function") throw unavailable();
    const leaseOwner = randomUUID();
    const claimTime = now();
    const claim = await prisma.escrowOperation.updateMany({
      where: { id: operation.id, status: "PENDING", attemptCount: { lt: 5 }, nextAttemptAt: { lte: claimTime }, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: claimTime } }] },
      data: { leaseOwner, leaseExpiresAt: new Date(claimTime.getTime() + 60_000), nextAttemptAt: new Date(claimTime.getTime() + 60_000), attemptCount: { increment: 1 } },
    });
    if (claim.count !== 1) return { status: "PENDING", inProgress: true, reconciliationRequired: operation.attemptCount >= 5 };
    const leavePending = async () => {
      const released = await prisma.escrowOperation.updateMany({ where: { id: operation.id, status: "PENDING", leaseOwner }, data: { leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now().getTime() + 60_000), failureCode: "PROVIDER_OUTCOME_UNKNOWN" } });
      if (released.count !== 1) throw unavailable();
      return { status: "PENDING", reconciliationRequired: true };
    };
    let result;
    try { result = await executor({ operationId: operation.id, transactionId: operation.transactionId, amountMinor: operation.amountMinor.toString(), currency: operation.currency.trim(), idempotencyKey: operation.operationKey }); }
    catch { return leavePending(); }
    if (!result || result.verified !== true || result.outcome !== "SUCCEEDED"
      || String(result.amountMinor) !== operation.amountMinor.toString() || result.currency !== operation.currency.trim()
      || typeof result.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(result.provider)
      || typeof result.providerReference !== "string" || result.providerReference.length < 1 || result.providerReference.length > 255
      || /[\u0000-\u001f\u007f]/.test(result.providerReference)) return leavePending();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, operation.transactionId);
        const current = await tx.escrowOperation.findUnique({ where: { id: operation.id } });
        if (!current || current.status !== "PENDING") return { status: current?.status ?? "PENDING", duplicate: true };
        const escrow = await tx.escrow.findUnique({ where: { id: current.escrowId } });
        const expected = current.type === "RELEASE" ? "RELEASE_PENDING" : "REFUND_PENDING";
        const finalEscrow = current.type === "RELEASE" ? "RELEASED" : "REFUNDED";
        const finalTransaction = current.type === "RELEASE" ? "COMPLETED" : "REFUNDED";
        if (!escrow || escrow.status !== expected || escrow.balanceMinor !== current.amountMinor) throw conflict("ESCROW_BALANCE_MISMATCH");
        const clearing = await account(tx, { transactionId: current.transactionId, currency: current.currency, accountCode: "PROVIDER_CLEARING", accountType: "ASSET" });
        const liability = await account(tx, { transactionId: current.transactionId, currency: current.currency, escrowId: escrow.id, accountCode: "ESCROW_LIABILITY", accountType: "LIABILITY" });
        const operationKey = `${current.type}:${current.id}`;
        const journal = current.type === "RELEASE"
          ? await postJournal(tx, { transactionId: current.transactionId, currency: current.currency, amountMinor: current.amountMinor, operationKey, debit: liability, credit: clearing })
          : await postJournal(tx, { transactionId: current.transactionId, currency: current.currency, amountMinor: current.amountMinor, operationKey, debit: liability, credit: clearing });
        const transaction = await tx.transaction.findUnique({ where: { id: current.transactionId } });
        if (!transaction || transaction.status !== expected) throw conflict("TRANSACTION_STATE_MISMATCH");
        const changed = await tx.transaction.updateMany({ where: { id: transaction.id, status: expected, version: transaction.version }, data: { status: finalTransaction, version: { increment: 1 } } });
        if (changed.count !== 1) throw conflict("TRANSACTION_VERSION_CONFLICT");
        await tx.escrow.update({ where: { id: escrow.id }, data: { status: finalEscrow, balanceMinor: 0n, ...(current.type === "RELEASE" ? { releasedAt: now() } : { refundedAt: now() }) } });
        const operationChanged = await tx.escrowOperation.updateMany({ where: { id: current.id, status: "PENDING", leaseOwner }, data: { status: "SUCCEEDED", provider: result.provider, providerReference: result.providerReference, ledgerJournalId: journal.id, completedAt: now(), leaseOwner: null, leaseExpiresAt: null, failureCode: null } });
        if (operationChanged.count !== 1) throw conflict("ESCROW_OPERATION_ALREADY_CLAIMED");
        await tx.transactionStatusHistory.create({ data: { transactionId: transaction.id, version: transaction.version + 1, previousStatus: expected, newStatus: finalTransaction, actorUserId: null, reason: `VERIFIED_${current.type}_OUTCOME` } });
        await audit(tx, null, `ESCROW_${current.type}_COMPLETED`, transaction.id, null, { operationId: current.id, ledgerJournalId: journal.id, provider: result.provider, providerReference: result.providerReference, amountMinor: current.amountMinor.toString(), currency: current.currency.trim() });
        return { status: "SUCCEEDED", ledgerJournalId: journal.id };
      });
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const getStatus = async ({ auth, transactionId }) => {
    const prisma = await getClient();
    const escrow = await prisma.escrow.findFirst({ where: { transactionId, transaction: { participants: { some: { userId: auth?.userId } } } } });
    if (!escrow) throw denied();
    return safeEscrow(escrow);
  };

  return Object.freeze({ recordVerifiedFunding, authorizeRelease, authorizeRefund, executeAuthorizedOperation, getStatus });
};
