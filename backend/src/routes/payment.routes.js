import { Router } from "express";
import { createPaymentController } from "../controllers/payment.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireTransactionParticipant, requirePaymentAttemptParticipant } from "../middleware/ownership.middleware.js";
import { createSharedRateLimiter } from "../middleware/rateLimit.middleware.js";
import { createPaymentService } from "../services/payment.service.js";
import { createRazorpayPaymentAdapter } from "../services/razorpay-payment.adapter.js";
import { createEscrowService } from "../services/escrow.service.js";
import { ApiError } from "../utils/ApiError.js";

export const createPaymentRouter = (dependencies = {}) => {
  const router = Router();
  const environment = dependencies.environment;
  const paymentConfig = environment?.integrations?.payment;
  const configuredAdapter = dependencies.paymentAdapter ?? (paymentConfig?.provider === "razorpay"
    ? createRazorpayPaymentAdapter({ apiKey: paymentConfig.apiKey, apiSecret: paymentConfig.apiSecret, webhookSecret: paymentConfig.webhookSecret, enabled: paymentConfig.enabled === true })
    : undefined);
  const service = dependencies.paymentService ?? createPaymentService({
    getClient: dependencies.getClient,
    adapter: configuredAdapter,
    enabled: paymentConfig?.enabled === true,
    provider: paymentConfig?.provider,
    fundingService: dependencies.escrowService ?? createEscrowService({ getClient: dependencies.getClient, ...(dependencies.escrowServiceOptions ?? {}) }),
  });
  const controller = createPaymentController({ paymentService: service });
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const limit = (operation, family, accountScope) => {
    if (environment?.rateLimit && dependencies.rateLimitStore) return createSharedRateLimiter({ windowMs: environment.rateLimit.windowMs, max: environment.rateLimit.max, store: dependencies.rateLimitStore, keySecret: environment.rateLimit.keySecret, operation, family, accountScope });
    if (environment?.nodeEnv === "production") return (_request, _response, next) => next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."));
    return (_request, _response, next) => next();
  };
  const paymentLimit = limit("payment-initiation", "payment", "payment-initiation");
  const webhookLimit = limit("payment-webhook", "payment-webhook", null);
  const paymentVerifyLimit = limit("payment-verification", "payment", "payment-verification");
  router.post("/transactions/:transactionId/payment-attempts", authentication, paymentLimit,
    requireTransactionParticipant({ getClient: dependencies.getClient, idParam: "transactionId", roles: ["BUYER"] }), controller.initiate);
  router.get("/payment-attempts/:paymentAttemptId", authentication,
    requirePaymentAttemptParticipant({ getClient: dependencies.getClient }), controller.getAttempt);
  router.post("/payment-attempts/:paymentAttemptId/verify", authentication, paymentVerifyLimit,
    requirePaymentAttemptParticipant({ getClient: dependencies.getClient }), controller.verifyCallback);
  router.post("/webhooks/:provider", webhookLimit, controller.webhook);
  return router;
};
