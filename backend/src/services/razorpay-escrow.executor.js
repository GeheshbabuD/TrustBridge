import { createHash } from "node:crypto";
import { getPrismaClient } from "../config/db.js";

const providerId = "razorpay";
const idempotency = (operationKey, length = 64) => createHash("sha256").update(operationKey).digest("hex").slice(0, length);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);

/**
 * Creates lease-driven escrow executors. The adapter must retain its own
 * provider-approval gates; account resolution must return a server-verified
 * Route linked account, never a client-supplied destination.
 */
export const createRazorpayEscrowExecutors = ({ getClient = getPrismaClient, adapter, resolveRouteAccount, refundsApproved = false, routeApproved = false } = {}) => {
  const refund = async ({ operationId, transactionId, amountMinor, currency, idempotencyKey, providerReference, persistProviderReference }) => {
    if (currency !== "INR" || !adapter || adapter.providerId !== providerId) throw new Error("ESCROW_PROVIDER_UNAVAILABLE");
    const prisma = await getClient();
    const funding = await prisma.escrowOperation.findFirst({ where: { transactionId, type: "FUNDING", status: "SUCCEEDED" }, include: { paymentAttempt: true }, orderBy: { completedAt: "desc" } });
    const attempt = funding?.paymentAttempt;
    if (!attempt || attempt.provider !== providerId || attempt.status !== "CAPTURED" || attempt.amountMinor < BigInt(amountMinor) || !identifier(attempt.capturedPaymentId)) throw new Error("CAPTURE_REFERENCE_UNAVAILABLE");
    let refundId = providerReference;
    if (refundId && !identifier(refundId)) throw new Error("PROVIDER_REFERENCE_INVALID");
    if (!refundId) {
      const created = await adapter.createRefund({ paymentId: attempt.capturedPaymentId, amountMinor, idempotencyKey: idempotency(idempotencyKey), financialContext: { operationId, transactionId, type: "REFUND", amountMinor, currency } });
      if (!created || created.paymentId !== attempt.capturedPaymentId || String(created.amountMinor) !== amountMinor || created.currency !== "INR" || !identifier(created.refundId)) throw new Error("PROVIDER_RESULT_INVALID");
      refundId = created.refundId;
      await persistProviderReference({ provider: providerId, providerReference: refundId });
    }
    const status = await adapter.fetchRefund({ paymentId: attempt.capturedPaymentId, refundId });
    if (!status || status.paymentId !== attempt.capturedPaymentId || status.refundId !== refundId || String(status.amountMinor) !== amountMinor || status.currency !== "INR") throw new Error("PROVIDER_RESULT_INVALID");
    if (status.status === "pending") return { verified: false, outcome: "PENDING", provider: providerId, providerReference: refundId };
    return { verified: true, outcome: status.status === "processed" ? "SUCCEEDED" : "FAILED", final: status.status === "failed", provider: providerId, providerReference: refundId, amountMinor, currency };
  };

  const release = async ({ operationId, transactionId, amountMinor, currency, idempotencyKey, providerReference, persistProviderReference }) => {
    if (currency !== "INR" || !adapter || adapter.providerId !== providerId || typeof resolveRouteAccount !== "function") throw new Error("ROUTE_EXECUTION_UNAVAILABLE");
    const prisma = await getClient();
    const operation = await prisma.escrowOperation.findUnique({ where: { id: operationId }, include: { transaction: { select: { sellerId: true } } } });
    const funding = await prisma.escrowOperation.findFirst({ where: { transactionId, type: "FUNDING", status: "SUCCEEDED" }, include: { paymentAttempt: true }, orderBy: { completedAt: "desc" } });
    const attempt = funding?.paymentAttempt;
    if (!operation || !attempt || attempt.provider !== providerId || attempt.status !== "CAPTURED" || attempt.amountMinor < BigInt(amountMinor) || !identifier(attempt.capturedPaymentId)) throw new Error("CAPTURE_REFERENCE_UNAVAILABLE");
    const accountId = await resolveRouteAccount({ sellerId: operation.transaction.sellerId, transactionId });
    if (!identifier(accountId)) throw new Error("ROUTE_ACCOUNT_UNAVAILABLE");
    let transferId = providerReference;
    if (transferId && !identifier(transferId)) throw new Error("PROVIDER_REFERENCE_INVALID");
    if (!transferId) {
      const created = await adapter.createRouteTransfer({ paymentId: attempt.capturedPaymentId, accountId, amountMinor, idempotencyKey: idempotency(idempotencyKey, 32), financialContext: { operationId, transactionId, type: "RELEASE", amountMinor, currency, approved: true } });
    if (!created || !identifier(created.transferId) || created.paymentId !== attempt.capturedPaymentId
      || created.accountId !== accountId || String(created.amountMinor) !== amountMinor || created.currency !== "INR") throw new Error("PROVIDER_RESULT_INVALID");
      transferId = created.transferId;
      await persistProviderReference({ provider: providerId, providerReference: transferId });
    }
    const status = await adapter.fetchRouteTransfer({ transferId });
    if (!status || status.transferId !== transferId || status.paymentId !== attempt.capturedPaymentId || status.accountId !== accountId || String(status.amountMinor) !== amountMinor || status.currency !== "INR") throw new Error("PROVIDER_RESULT_INVALID");
    if (status.status === "processed" && status.settlementStatus === "settled") return { verified: true, outcome: "SUCCEEDED", final: true, provider: providerId, providerReference: transferId, amountMinor, currency };
    if (status.status === "failed") return { verified: true, outcome: "FAILED", final: true, provider: providerId, providerReference: transferId, amountMinor, currency };
    return { verified: false, outcome: "PENDING", provider: providerId, providerReference: transferId };
  };

  return Object.freeze({
    ...(refundsApproved ? { refund } : {}),
    ...(routeApproved && typeof resolveRouteAccount === "function" ? { release } : {}),
  });
};
