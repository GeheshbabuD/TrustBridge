import { createHash, createHmac, randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { getEnv } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { enqueueTransactionNotice } from "./notification-event.service.js";
import { resolvePaymentAdapter } from "./payment-provider.service.js";

const unavailable = () => new ApiError(503, "PAYMENT_UNAVAILABLE", "Payment service is temporarily unavailable");
const denied = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const conflict = (code = "PAYMENT_CONFLICT") => new ApiError(409, code, "Payment operation conflicts with current state");
const safeOutcome = (row) => ({ id: row.id, status: row.status, amountMinor: row.amountMinor.toString(), currency: row.currency.trim(), createdAt: row.createdAt, updatedAt: row.updatedAt });
const checkoutConfiguration = (attempt, providerAdapter) => {
  if (!attempt || attempt.provider !== "razorpay" || attempt.status !== "PENDING"
    || typeof attempt.providerReference !== "string" || !attempt.providerReference
    || typeof providerAdapter?.getCheckoutConfiguration !== "function"
    || attempt.currency.trim() !== "INR") return null;
  let configuration;
  try { configuration = providerAdapter.getCheckoutConfiguration(); } catch { return null; }
  const amount = Number(attempt.amountMinor);
  if (!configuration || typeof configuration.key !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(configuration.key)
    || !Number.isSafeInteger(amount) || amount < 1) return null;
  return { key: configuration.key, order_id: attempt.providerReference, amount, currency: attempt.currency.trim() };
};
const stableFingerprint = (secret, values) => createHmac("sha256", secret ?? getEnv().rateLimit.keySecret).update(JSON.stringify(values)).digest("hex");
const validNormalizedEvent = (event) => Boolean(event
  && typeof event.eventId === "string" && /^[A-Za-z0-9._:-]{1,255}$/.test(event.eventId)
  && event.providerAccountScope === "default"
  && typeof event.eventType === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(event.eventType)
  && typeof event.providerReference === "string" && event.providerReference.length <= 255 && !/[\u0000-\u001f\u007f]/.test(event.providerReference)
  && (event.paymentReference === undefined || (typeof event.paymentReference === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(event.paymentReference)))
  && ["PENDING", "CAPTURED", "FAILED", "CANCELLED"].includes(event.outcome)
  && typeof event.amountMinor === "string" && /^[1-9]\d{0,18}$/.test(event.amountMinor)
  && typeof event.currency === "string" && /^[A-Z]{3}$/.test(event.currency));

export const createPaymentService = ({ getClient = getPrismaClient, adapter, enabled = false, provider, fundingService, fingerprintSecret = "payment-test-fingerprint", now = () => new Date() } = {}) => {
  const lockTransaction = (tx, id) => tx.$queryRaw`SELECT "id" FROM "transactions" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const audit = (tx, actorUserId, action, transactionId, requestId, metadata) => tx.auditLog.create({ data: { actorUserId: actorUserId ?? null, action, entityType: "PaymentAttempt", entityId: transactionId, requestId: requestId ?? null, metadata } });
  const quarantineWebhookConflict = async (tx, current, incomingProvider, event, payloadSha256, requestId) => {
    if (current.eventData?.payloadSha256 === payloadSha256) {
      return current.lastErrorCode === "EVENT_ID_PAYLOAD_CONFLICT"
        ? { accepted: true, duplicate: true, integrityConflict: true, reconciliationRequired: true }
        : { accepted: true, duplicate: true };
    }
    await tx.webhookEvent.update({ where: { id: current.id }, data: { lastErrorCode: "EVENT_ID_PAYLOAD_CONFLICT" } });
    await tx.auditLog.create({ data: {
      action: "PAYMENT_WEBHOOK_INTEGRITY_CONFLICT",
      entityType: "WebhookEvent",
      entityId: current.id,
      requestId: requestId ?? null,
      metadata: {
        provider: incomingProvider,
        eventId: event.eventId,
        acceptedPayloadSha256: current.eventData?.payloadSha256 ?? null,
        conflictingPayloadSha256: payloadSha256,
      },
    } });
    return { accepted: true, duplicate: false, integrityConflict: true, reconciliationRequired: true };
  };
  const classifyDuplicateWebhook = async ({ prisma, incomingProvider, event, payloadSha256, requestId, persistedEvent }) => {
    try {
      const eventRow = persistedEvent ?? await prisma.webhookEvent.findUnique({
        where: { provider_providerAccountScope_eventId: { provider: incomingProvider, providerAccountScope: event.providerAccountScope, eventId: event.eventId } },
      });
      if (!eventRow) return null;
      return await prisma.$transaction(async (tx) => {
        const current = await tx.webhookEvent.findUnique({ where: { id: eventRow.id } });
        if (!current) throw unavailable();
        return quarantineWebhookConflict(tx, current, incomingProvider, event, payloadSha256, requestId);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };
  const currentAdapter = () => {
    if (!enabled) throw unavailable();
    try { return resolvePaymentAdapter({ adapter, provider }); } catch { throw unavailable(); }
  };

  const initiate = async ({ auth, transactionId, idempotencyKey, requestId }) => {
    if (!auth || !auth.userId || !Number.isSafeInteger(auth.authVersion) || auth.role !== "USER") throw denied();
    const providerAdapter = currentAdapter();
    if (!providerAdapter.capabilities?.idempotentIntentCreation || typeof providerAdapter.createPaymentIntent !== "function") throw unavailable();
    const prisma = await getClient();
    const scope = `PAYMENT_INITIATE:${transactionId}:${auth.userId}`;
    const stamp = now();
    let reserved;
    try {
      reserved = await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, transactionId);
        const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: { id: true, buyerId: true, status: true, amountMinor: true, currency: true, version: true } });
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { status: true, authVersion: true, role: true } });
        const membership = await tx.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId, userId: auth.userId } }, select: { role: true } });
        if (!transaction || !user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion || user.role !== "USER"
          || transaction.buyerId !== auth.userId || membership?.role !== "BUYER") throw denied();
        if (transaction.status !== "AWAITING_PAYMENT") throw conflict("PAYMENT_TRANSACTION_INELIGIBLE");
        const acceptedTerms = await tx.transactionTermsVersion.findFirst({ where: { transactionId }, orderBy: { version: "desc" }, select: { id: true, status: true, amountMinor: true, currency: true, decisions: { select: { actorUserId: true, decision: true } } } });
        if (!acceptedTerms || acceptedTerms.amountMinor !== transaction.amountMinor || acceptedTerms.currency.trim() !== transaction.currency.trim()) throw conflict("PAYMENT_TERMS_UNAVAILABLE");
        if (acceptedTerms.status !== "LEGACY_ACCEPTED") {
          const acceptedBy = new Set(acceptedTerms.decisions.filter((decision) => decision.decision === "ACCEPTED").map((decision) => decision.actorUserId));
          if (!acceptedBy.has(transaction.buyerId)) throw conflict("PAYMENT_TERMS_UNAVAILABLE");
        }
        const fingerprint = stableFingerprint(fingerprintSecret, [transactionId, auth.userId, transaction.amountMinor.toString(), transaction.currency.trim()]);
        const prior = await tx.idempotencyOperation.findUnique({ where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey } } });
        if (prior) {
          if (prior.requestFingerprint !== fingerprint || prior.resourceType !== "PaymentAttempt" || !prior.resourceId) throw conflict("IDEMPOTENCY_KEY_REUSED");
          const existing = await tx.paymentAttempt.findUnique({ where: { id: prior.resourceId } });
          if (!existing) throw unavailable();
          return { attempt: existing, dispatch: existing.providerReference === null && ["CREATED", "PENDING"].includes(existing.status), idempotent: true };
        }
        const active = await tx.paymentAttempt.findFirst({ where: { transactionId, status: { in: ["CREATED", "PENDING"] } }, select: { id: true } });
        if (active) throw conflict("PAYMENT_ATTEMPT_ACTIVE");
        await tx.idempotencyOperation.create({ data: { operationScope: scope, idempotencyKey, requestFingerprint: fingerprint, status: "IN_PROGRESS", expiresAt: new Date(stamp.getTime() + 24 * 60 * 60 * 1000) } });
        const attempt = await tx.paymentAttempt.create({ data: { transactionId, provider: providerAdapter.providerId, idempotencyKey, status: "CREATED", amountMinor: transaction.amountMinor, currency: transaction.currency } });
        await tx.outboxEvent.create({ data: { eventKey: `PAYMENT_INTENT:${attempt.id}`, eventType: "PAYMENT_INTENT_CREATE", aggregateType: "PaymentAttempt", aggregateId: attempt.id, transactionId, payload: { attemptId: attempt.id, provider: providerAdapter.providerId }, nextAttemptAt: stamp } });
        await enqueueTransactionNotice(tx, { transactionId, template: "PAYMENT_STATUS_CHANGED", discriminator: `${attempt.id}:PENDING` });
        await tx.idempotencyOperation.update({ where: { operationScope_idempotencyKey: { operationScope: scope, idempotencyKey } }, data: { status: "COMPLETED", resourceType: "PaymentAttempt", resourceId: attempt.id, completedAt: stamp } });
        await audit(tx, auth.userId, "PAYMENT_ATTEMPT_CREATED", transactionId, requestId, { paymentAttemptId: attempt.id, amountMinor: transaction.amountMinor.toString(), currency: transaction.currency.trim() });
        return { attempt, dispatch: true, idempotent: false };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002" || error?.code === "P2034") throw conflict("PAYMENT_CONFLICT");
      throw unavailable();
    }
    if (reserved.dispatch) await dispatchIntent(reserved.attempt.id, { requestId });
    const latest = reserved.dispatch ? await prisma.paymentAttempt.findUnique({ where: { id: reserved.attempt.id } }).catch(() => reserved.attempt) : reserved.attempt;
    const checkout = checkoutConfiguration(latest, providerAdapter);
    return { attempt: safeOutcome(latest), accepted: true, idempotent: reserved.idempotent, ...(checkout ? { checkout } : {}) };
  };

  const dispatchIntent = async (attemptId, { requestId } = {}) => {
    const prisma = await getClient();
    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.provider !== provider || !["CREATED", "PENDING"].includes(attempt.status) || attempt.providerReference) return;
    const providerAdapter = currentAdapter();
    const leaseOwner = randomUUID();
    const claimedAt = now();
    const claimed = await prisma.$transaction(async (tx) => {
      await lockTransaction(tx, attempt.transactionId);
      const current = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
      if (!current || !["CREATED", "PENDING"].includes(current.status) || current.providerReference) return false;
      const claim = await tx.outboxEvent.updateMany({
        where: { eventKey: `PAYMENT_INTENT:${attempt.id}`, OR: [
          { status: "PENDING", nextAttemptAt: { lte: claimedAt } },
          { status: "PROCESSING", leaseExpiresAt: { lte: claimedAt } },
        ] },
        data: { status: "PROCESSING", attemptCount: { increment: 1 }, leaseOwner, claimedAt, leaseExpiresAt: new Date(claimedAt.getTime() + 60_000) },
      });
      return claim.count === 1;
    }).catch(() => { throw unavailable(); });
    if (!claimed) return;
    try {
      const result = await providerAdapter.createPaymentIntent({ attemptId, idempotencyKey: attempt.idempotencyKey, amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim() });
      if (!result || typeof result.providerReference !== "string" || !result.providerReference.length || result.providerReference.length > 255 || /[\u0000-\u001f\u007f]/.test(result.providerReference) || result.status !== "PENDING") throw new Error("PROVIDER_RESULT_INVALID");
      await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, attempt.transactionId);
        const updated = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, transactionId: attempt.transactionId, provider: attempt.provider, status: { in: ["CREATED", "PENDING"] }, OR: [{ providerReference: null }, { providerReference: result.providerReference }] }, data: { status: "PENDING", providerReference: result.providerReference, failureCode: null } });
        if (updated.count !== 1) {
          const current = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
          if (current && ["CAPTURED", "FAILED", "CANCELLED"].includes(current.status)) {
            await tx.outboxEvent.updateMany({ where: { eventKey: `PAYMENT_INTENT:${attempt.id}`, status: "PROCESSING", leaseOwner }, data: { status: "PUBLISHED", publishedAt: now(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null } });
            return;
          }
          throw unavailable();
        }
        const published = await tx.outboxEvent.updateMany({ where: { eventKey: `PAYMENT_INTENT:${attempt.id}`, status: "PROCESSING", leaseOwner }, data: { status: "PUBLISHED", publishedAt: now(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null } });
        if (published.count !== 1) throw unavailable();
        await audit(tx, null, "PAYMENT_INTENT_DISPATCHED", attempt.transactionId, requestId, { paymentAttemptId: attempt.id });
      });
    } catch {
      // Dispatch may have reached the provider. Preserve the unresolved attempt
      // and outbox record; retries use the same provider idempotency key.
      await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, attempt.transactionId);
        await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["CREATED", "PENDING"] } }, data: { status: "PENDING", failureCode: "PROVIDER_OUTCOME_UNKNOWN" } });
        await tx.outboxEvent.updateMany({ where: { eventKey: `PAYMENT_INTENT:${attempt.id}`, status: "PROCESSING", leaseOwner }, data: { status: "PENDING", nextAttemptAt: new Date(now().getTime() + 60_000), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: "PROVIDER_OUTCOME_UNKNOWN" } });
      }).catch(() => { throw unavailable(); });
    }
  };

  const getAttempt = async ({ auth, paymentAttemptId }) => {
    const prisma = await getClient();
    const attempt = await prisma.paymentAttempt.findFirst({ where: { id: paymentAttemptId, transaction: { participants: { some: { userId: auth?.userId } } } } });
    if (!attempt) throw denied();
    let providerAdapter = null;
    try { providerAdapter = currentAdapter(); } catch { /* read-only status remains available while provider is disabled */ }
    const checkout = checkoutConfiguration(attempt, providerAdapter);
    return { ...safeOutcome(attempt), ...(checkout ? { checkout } : {}) };
  };

  const verifyPaymentCallback = async ({ auth, paymentAttemptId, orderId, paymentId, signature, requestId }) => {
    const prisma = await getClient();
    const attempt = await prisma.paymentAttempt.findFirst({ where: { id: paymentAttemptId, transaction: { participants: { some: { userId: auth?.userId } } } } });
    const providerAdapter = currentAdapter();
    if (!attempt || attempt.provider !== provider || attempt.providerReference !== orderId
      || typeof providerAdapter.verifyPaymentSignature !== "function" || typeof providerAdapter.fetchPaymentDetails !== "function"
      || providerAdapter.verifyPaymentSignature({ orderId, paymentId, signature }) !== true) throw denied();
    let providerPayment;
    try { providerPayment = await providerAdapter.fetchPaymentDetails({ paymentId }); } catch { throw unavailable(); }
    if (!providerPayment || providerPayment.paymentId !== paymentId || providerPayment.orderId !== attempt.providerReference
      || String(providerPayment.amountMinor) !== attempt.amountMinor.toString() || providerPayment.currency !== attempt.currency.trim()) throw conflict("PAYMENT_EVENT_MISMATCH");
    if (providerPayment.status !== "captured") return { paymentAttempt: safeOutcome(attempt), verified: true, captured: false };
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, attempt.transactionId);
        const current = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { status: true, authVersion: true, role: true } });
        const participant = await tx.transactionParticipant.findUnique({ where: { transactionId_userId: { transactionId: attempt.transactionId, userId: auth.userId } }, select: { role: true } });
        if (!current || current.providerReference !== orderId || !user || user.status !== "ACTIVE" || user.role !== "USER"
          || user.authVersion !== auth.authVersion || !participant || !["BUYER", "SELLER"].includes(participant.role)) throw denied();
        const inboxEventId = `checkout:${paymentId}`;
        const inbox = await tx.webhookEvent.create({ data: { provider: current.provider, providerAccountScope: "default", eventId: inboxEventId, eventType: "payment.checkout_verified", paymentAttemptId: current.id, status: "PROCESSED", attemptCount: 1, eventData: { providerReference: orderId, paymentReference: paymentId, outcome: "CAPTURED", amountMinor: current.amountMinor.toString(), currency: current.currency.trim(), source: "SIGNED_CHECKOUT_AND_API_FETCH" }, processedAt: now() } });
        if (["FAILED", "CANCELLED"].includes(current.status)) throw conflict("PAYMENT_EVENT_CONFLICT");
        if (current.provider === "razorpay" && current.capturedPaymentId && current.capturedPaymentId !== paymentId) throw conflict("PAYMENT_EVENT_MISMATCH");
        const captured = current.status === "CAPTURED" ? current : await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: "CAPTURED", ...(current.provider === "razorpay" ? { capturedPaymentId: paymentId } : {}), failureCode: null } });
        if (fundingService) await fundingService.recordVerifiedFunding({ tx, paymentAttempt: captured, actorUserId: auth.userId, requestId });
        await audit(tx, auth.userId, "PAYMENT_ATTEMPT_CAPTURE_VERIFIED", current.transactionId, requestId, { paymentAttemptId: current.id, eventId: inbox.eventId, source: "SIGNED_CHECKOUT_AND_API_FETCH" });
        return { paymentAttempt: safeOutcome({ ...current, status: "CAPTURED", updatedAt: now() }), verified: true, captured: true };
      });
    } catch (error) {
      if (error?.code === "P2002") {
        const persisted = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } }).catch(() => null);
        if (persisted?.status === "CAPTURED" && persisted.capturedPaymentId === paymentId) return { paymentAttempt: safeOutcome(persisted), verified: true, captured: true, duplicate: true };
        throw conflict("PAYMENT_EVENT_MISMATCH");
      }
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };

  const reconcile = async ({ paymentAttemptId, requestId }) => {
    const prisma = await getClient();
    const pending = await prisma.paymentAttempt.findUnique({ where: { id: paymentAttemptId } });
    if (!pending) throw denied();
    const providerAdapter = currentAdapter();
    if (!providerAdapter.capabilities?.statusLookup || typeof providerAdapter.fetchPaymentStatus !== "function" || !pending.providerReference) throw unavailable();
    let result;
    try { result = await providerAdapter.fetchPaymentStatus({ providerReference: pending.providerReference, amountMinor: pending.amountMinor.toString(), currency: pending.currency.trim() }); } catch { throw unavailable(); }
    if (!result || result.verified !== true || result.providerReference !== pending.providerReference
      || !["PENDING", "CAPTURED", "FAILED", "CANCELLED"].includes(result.outcome)
      || (pending.provider === "razorpay" && result.outcome === "CAPTURED" && (typeof result.paymentReference !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(result.paymentReference)))
      || String(result.amountMinor) !== pending.amountMinor.toString() || result.currency !== pending.currency.trim()
      || (["FAILED", "CANCELLED"].includes(result.outcome) && (result.final !== true || result.noCapture !== true))) throw conflict("PAYMENT_EVENT_UNVERIFIED");
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, pending.transactionId);
        const attempt = await tx.paymentAttempt.findUnique({ where: { id: pending.id } });
        if (!attempt || attempt.providerReference !== pending.providerReference || attempt.amountMinor !== pending.amountMinor || attempt.currency.trim() !== pending.currency.trim()) throw conflict("PAYMENT_EVENT_MISMATCH");
        const eventId = `reconcile:${attempt.id}:${result.outcome}`;
        const event = await tx.webhookEvent.create({ data: { provider: attempt.provider, providerAccountScope: "default", eventId, eventType: "payment.reconciled", paymentAttemptId: attempt.id, status: "PROCESSING", attemptCount: 1, eventData: { source: "STATUS_LOOKUP", providerReference: attempt.providerReference, outcome: result.outcome, final: result.final === true, amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim(), noCapture: result.noCapture === true } } });
        if (["CAPTURED", "FAILED", "CANCELLED"].includes(attempt.status)) {
          if (attempt.status !== result.outcome) {
            await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastErrorCode: "CONTRADICTORY_TERMINAL_EVENT", processedAt: now() } });
            await audit(tx, null, "PAYMENT_EVENT_CONFLICT", attempt.transactionId, requestId, { paymentAttemptId: attempt.id, source: "STATUS_LOOKUP", outcome: result.outcome });
            return { status: attempt.status, reconciliationRequired: true };
          }
          if (attempt.status === "CAPTURED" && attempt.provider === "razorpay") {
            if (!result.paymentReference || (attempt.capturedPaymentId && attempt.capturedPaymentId !== result.paymentReference)) throw conflict("PAYMENT_EVENT_MISMATCH");
            if (!attempt.capturedPaymentId) await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { capturedPaymentId: result.paymentReference } });
          }
          if (result.outcome === "CAPTURED" && fundingService) await fundingService.recordVerifiedFunding({ tx, paymentAttempt: attempt, requestId });
        } else {
          const updatedAttempt = await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: result.outcome, ...(result.outcome === "CAPTURED" && attempt.provider === "razorpay" ? { capturedPaymentId: result.paymentReference } : {}), failureCode: result.outcome === "FAILED" ? "PROVIDER_FINAL_FAILURE" : null } });
          if (result.outcome === "CAPTURED" && fundingService) await fundingService.recordVerifiedFunding({ tx, paymentAttempt: updatedAttempt, requestId });
        }
        await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: now() } });
        await audit(tx, null, "PAYMENT_ATTEMPT_RECONCILED", attempt.transactionId, requestId, { paymentAttemptId: attempt.id, status: result.outcome, source: "STATUS_LOOKUP" });
        await enqueueTransactionNotice(tx, { transactionId: attempt.transactionId, template: "PAYMENT_STATUS_CHANGED", discriminator: `${attempt.id}:${result.outcome}:reconciled` });
        return { status: result.outcome, reconciled: true };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "P2002") {
        const persisted = await prisma.paymentAttempt.findUnique({ where: { id: pending.id } }).catch(() => null);
        if (persisted?.status === "CAPTURED" && persisted.capturedPaymentId === result.paymentReference) return { status: "CAPTURED", reconciled: true, duplicate: true };
        throw conflict("PAYMENT_EVENT_MISMATCH");
      }
      throw unavailable();
    }
  };

  const receiveWebhook = async ({ provider: incomingProvider, rawBody, signature, eventId, requestId }) => {
    const providerAdapter = currentAdapter();
    if (providerAdapter.providerId !== incomingProvider || typeof providerAdapter.verifyWebhook !== "function" || typeof providerAdapter.normalizeWebhook !== "function") throw denied();
    if (!Buffer.isBuffer(rawBody)) throw denied();
    let verified = false;
    try { verified = await providerAdapter.verifyWebhook({ rawBody, signature, receivedAt: now() }); } catch { verified = false; }
    if (!verified) throw denied();
    const event = providerAdapter.normalizeWebhook({ rawBody, headers: { eventId } });
    if (!validNormalizedEvent(event)) throw denied();
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const prisma = await getClient();
    const priorEvent = await prisma.webhookEvent.findUnique({ where: { provider_providerAccountScope_eventId: { provider: incomingProvider, providerAccountScope: event.providerAccountScope, eventId: event.eventId } } });
    if (priorEvent) return classifyDuplicateWebhook({ prisma, incomingProvider, event, payloadSha256, requestId, persistedEvent: priorEvent });
    let attempt = await prisma.paymentAttempt.findFirst({ where: { provider: incomingProvider, providerReference: event.providerReference } });
    if (!attempt) {
      try { await prisma.webhookEvent.create({ data: { provider: incomingProvider, providerAccountScope: event.providerAccountScope, eventId: event.eventId, eventType: event.eventType, status: "IGNORED", eventData: { reason: "UNKNOWN_PAYMENT_REFERENCE", payloadSha256 }, processedAt: now() } }); }
      catch (error) {
        if (error?.code !== "P2002") throw unavailable();
        const duplicate = await classifyDuplicateWebhook({ prisma, incomingProvider, event, payloadSha256, requestId });
        if (duplicate) return duplicate;
        throw conflict("PAYMENT_EVENT_MISMATCH");
      }
      return { accepted: true, duplicate: false };
    }
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTransaction(tx, attempt.transactionId);
        const duplicateEvent = await tx.webhookEvent.findUnique({ where: { provider_providerAccountScope_eventId: { provider: incomingProvider, providerAccountScope: event.providerAccountScope, eventId: event.eventId } } });
        if (duplicateEvent) return quarantineWebhookConflict(tx, duplicateEvent, incomingProvider, event, payloadSha256, requestId);
        attempt = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
        if (!attempt || attempt.provider !== incomingProvider || attempt.providerReference !== event.providerReference
          || attempt.amountMinor.toString() !== event.amountMinor || attempt.currency.trim() !== event.currency) throw conflict("PAYMENT_EVENT_MISMATCH");
        if (event.outcome === "CAPTURED" && incomingProvider === "razorpay" && !event.paymentReference) throw conflict("PAYMENT_EVENT_MISMATCH");
        const inbox = await tx.webhookEvent.create({ data: { provider: incomingProvider, providerAccountScope: event.providerAccountScope, eventId: event.eventId, eventType: event.eventType, paymentAttemptId: attempt.id, status: "PROCESSING", attemptCount: 1, eventData: { providerReference: event.providerReference, ...(event.paymentReference ? { paymentReference: event.paymentReference } : {}), outcome: event.outcome, final: event.final === true, amountMinor: event.amountMinor, currency: event.currency, noCapture: event.noCapture === true, providerOccurredAt: event.providerOccurredAt, payloadSha256 } } });
        if (attempt.status === "CAPTURED" || ["FAILED", "CANCELLED"].includes(attempt.status)) {
          if (attempt.status === event.outcome) {
            if (attempt.status === "CAPTURED" && attempt.provider === "razorpay") {
              if (!event.paymentReference || (attempt.capturedPaymentId && attempt.capturedPaymentId !== event.paymentReference)) throw conflict("PAYMENT_EVENT_MISMATCH");
              if (!attempt.capturedPaymentId) await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { capturedPaymentId: event.paymentReference } });
            }
            if (event.outcome === "CAPTURED" && fundingService) await fundingService.recordVerifiedFunding({ tx, paymentAttempt: attempt, requestId });
            await tx.webhookEvent.update({ where: { id: inbox.id }, data: { status: "PROCESSED", processedAt: now() } });
            return { accepted: true, duplicate: false };
          }
          await tx.webhookEvent.update({ where: { id: inbox.id }, data: { status: "FAILED", lastErrorCode: "CONTRADICTORY_TERMINAL_EVENT", processedAt: now() } });
          await audit(tx, null, "PAYMENT_EVENT_CONFLICT", attempt.transactionId, requestId, { paymentAttemptId: attempt.id, eventId: event.eventId, outcome: event.outcome });
          return { accepted: true, duplicate: false, reconciliationRequired: true };
        }
        if (!["CREATED", "PENDING"].includes(attempt.status)) throw conflict("PAYMENT_CONFLICT");
        if (["FAILED", "CANCELLED"].includes(event.outcome) && (event.final !== true || event.noCapture !== true)) {
          await tx.webhookEvent.update({ where: { id: inbox.id }, data: { status: "FAILED", lastErrorCode: "NO_FINAL_NO_CAPTURE_EVIDENCE", processedAt: now() } });
          await audit(tx, null, "PAYMENT_EVENT_REQUIRES_RECONCILIATION", attempt.transactionId, requestId, { paymentAttemptId: attempt.id, eventId: event.eventId });
          return { accepted: true, duplicate: false, reconciliationRequired: true };
        }
        const nextStatus = event.outcome === "PENDING" ? "PENDING" : event.outcome;
        if (event.outcome === "CAPTURED" && attempt.provider === "razorpay" && attempt.capturedPaymentId && attempt.capturedPaymentId !== event.paymentReference) throw conflict("PAYMENT_EVENT_MISMATCH");
        const updatedAttempt = await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: nextStatus, ...(nextStatus === "CAPTURED" && incomingProvider === "razorpay" ? { capturedPaymentId: event.paymentReference } : {}), failureCode: nextStatus === "FAILED" ? "PROVIDER_FINAL_FAILURE" : null } });
        if (nextStatus === "CAPTURED" && fundingService) await fundingService.recordVerifiedFunding({ tx, paymentAttempt: updatedAttempt, requestId });
        await tx.webhookEvent.update({ where: { id: inbox.id }, data: { status: "PROCESSED", processedAt: now() } });
        await audit(tx, null, "PAYMENT_ATTEMPT_STATUS_CHANGED", attempt.transactionId, requestId, { paymentAttemptId: attempt.id, previousStatus: attempt.status, newStatus: nextStatus, eventId: event.eventId, amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim() });
        await enqueueTransactionNotice(tx, { transactionId: attempt.transactionId, template: "PAYMENT_STATUS_CHANGED", discriminator: `${attempt.id}:${nextStatus}:${event.eventId}` });
        return { accepted: true, duplicate: false, status: nextStatus };
      });
    } catch (error) {
      if (error?.code === "P2002") {
        const duplicate = await classifyDuplicateWebhook({ prisma, incomingProvider, event, payloadSha256, requestId });
        if (duplicate) return duplicate;
        throw conflict("PAYMENT_EVENT_MISMATCH");
      }
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  };

  return Object.freeze({ initiate, getAttempt, verifyPaymentCallback, receiveWebhook, reconcile, dispatchIntent });
};
