import { getPrismaClient } from "../config/db.js";
import { createEscrowService } from "./escrow.service.js";
import { createRazorpayPaymentAdapter } from "./razorpay-payment.adapter.js";
import { createRazorpayEscrowExecutors } from "./razorpay-escrow.executor.js";

const authorizePersistedOperation = (getClient, expectedType) => async ({ operationId, transactionId, type, amountMinor, currency }) => {
  if (type !== expectedType || typeof operationId !== "string" || typeof transactionId !== "string") return false;
  try {
    const prisma = await getClient();
    const operation = await prisma.escrowOperation.findFirst({ where: {
      id: operationId, transactionId, type: expectedType, status: "PENDING", completedAt: null,
      actorUserId: { not: null }, amountMinor: BigInt(amountMinor), currency,
    }, select: { id: true } });
    return Boolean(operation);
  } catch { return false; }
};

/** Composes financial execution only from explicit validated deployment policy. */
export const composeEscrowRuntime = ({
  paymentConfig, getClient = getPrismaClient, paymentAdapter, escrowService,
  escrowServiceOptions, resolveRouteAccount,
} = {}) => {
  const enabled = paymentConfig?.enabled === true
    && paymentConfig?.provider === "razorpay"
    && paymentConfig?.escrowExecutionEnabled === true;
  const adapter = enabled
    ? createRazorpayPaymentAdapter({
      apiKey: paymentConfig.apiKey,
      apiSecret: paymentConfig.apiSecret,
      webhookSecret: paymentConfig.webhookSecret,
      enabled: true,
      refundsEnabled: paymentConfig.refundsApproved === true,
      routeEnabled: paymentConfig.routeApproved === true && typeof resolveRouteAccount === "function",
      authorizeRefund: authorizePersistedOperation(getClient, "REFUND"),
      authorizeRoute: authorizePersistedOperation(getClient, "RELEASE"),
    })
    : paymentAdapter;
  const executors = enabled && adapter?.providerId === "razorpay"
    ? createRazorpayEscrowExecutors({
      getClient, adapter, resolveRouteAccount,
      refundsApproved: paymentConfig.refundsApproved === true,
      routeApproved: paymentConfig.routeApproved === true && typeof resolveRouteAccount === "function",
    })
    : {};
  const service = escrowService ?? createEscrowService({ getClient, ...executors, ...escrowServiceOptions });
  const workerEnabled = enabled && Object.keys(executors).length > 0;
  return Object.freeze({ adapter, escrowService: service, workerEnabled });
};
