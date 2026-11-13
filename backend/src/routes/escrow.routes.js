import { Router } from "express";
import { createEscrowController } from "../controllers/escrow.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRoles } from "../middleware/role.middleware.js";
import { requireTransactionParticipant } from "../middleware/ownership.middleware.js";
import { createStepUpAuthorizationMiddleware } from "../middleware/recentMfa.middleware.js";
import { DEFAULT_STEP_UP_PURPOSES } from "../services/step-up-purpose.registry.js";
import { createEscrowService } from "../services/escrow.service.js";
import { ApiError } from "../utils/ApiError.js";
import { escrowIdempotencyKeySchema, escrowOperationSchema, escrowTransactionIdSchema } from "../validators/escrow.validator.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.middleware.js";

export const createEscrowRouter = (dependencies = {}) => {
  const router = Router();
  const service = dependencies.escrowService ?? createEscrowService({ getClient: dependencies.getClient, ...(dependencies.escrowServiceOptions ?? {}) });
  const controller = createEscrowController({ escrowService: service });
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const purposes = dependencies.stepUpPurposes
    ? Object.freeze({ ...DEFAULT_STEP_UP_PURPOSES, ...(dependencies.stepUpPurposes instanceof Map ? Object.fromEntries(dependencies.stepUpPurposes) : dependencies.stepUpPurposes) })
    : DEFAULT_STEP_UP_PURPOSES;
  const createStepUp = dependencies.stepUpAuthorizationMiddlewareFactory ?? createStepUpAuthorizationMiddleware;
  const transactionParamsSchema = z.object({ transactionId: escrowTransactionIdSchema }).strict();
  const validateEscrowStatusResource = validateRequest({ params: transactionParamsSchema });
  const validate = (expectedReason) => (request, _response, next) => {
    const body = escrowOperationSchema.safeParse(request.body);
    const key = escrowIdempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!body.success || body.data.reasonCode !== expectedReason || !key.success || !escrowTransactionIdSchema.safeParse(request.params.transactionId).success) return next(new ApiError(400, "VALIDATION_ERROR", "Request validation failed"));
    request.escrowOperation = { reasonCode: body.data.reasonCode, idempotencyKey: key.data };
    return next();
  };
  const releaseStepUp = createStepUp({ purpose: "ESCROW_RELEASE", resourceIdParam: "transactionId", purposeRegistry: purposes, getClient: dependencies.getClient });
  const refundStepUp = createStepUp({ purpose: "ESCROW_REFUND", resourceIdParam: "transactionId", purposeRegistry: purposes, getClient: dependencies.getClient });
  router.get("/transactions/:transactionId/escrow", authentication, validateEscrowStatusResource, requireTransactionParticipant({ getClient: dependencies.getClient }), controller.status);
  router.post("/transactions/:transactionId/escrow/release", authentication,
    validate("BUYER_ACCEPTED_DELIVERY"), requireTransactionParticipant({ getClient: dependencies.getClient, roles: ["BUYER"] }), releaseStepUp, controller.release);
  router.post("/transactions/:transactionId/escrow/refund", authentication,
    validate("ADMIN_RESOLVED_REFUND"), requireRoles("ADMIN"), refundStepUp, controller.refund);
  return router;
};
