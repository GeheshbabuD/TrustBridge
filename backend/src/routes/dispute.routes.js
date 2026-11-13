import express, { Router } from "express";
import { createDisputeController } from "../controllers/dispute.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRoles } from "../middleware/role.middleware.js";
import { requireTransactionParticipant, requireDisputeParticipant, requireEvidenceParticipant } from "../middleware/ownership.middleware.js";
import { createStepUpAuthorizationMiddleware } from "../middleware/recentMfa.middleware.js";
import { DEFAULT_STEP_UP_PURPOSES } from "../services/step-up-purpose.registry.js";
import { createDisputeService } from "../services/dispute.service.js";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { z } from "zod";
import { disputeCreateSchema, disputeIdempotencyKeySchema, disputeIdSchema, disputeParamsSchema, disputeResolutionSchema, disputeResponseSchema, evidenceCategorySchema, transactionIdSchema } from "../validators/dispute.validator.js";
import { validateRequest } from "../middleware/validate.middleware.js";

const uploadTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const createDisputeRouter = (dependencies = {}) => {
  const router = Router(); const getClient = dependencies.getClient ?? getPrismaClient;
  const service = dependencies.disputeService ?? createDisputeService({ getClient, storage: dependencies.evidenceStorage });
  const controller = createDisputeController({ disputeService: service });
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const purposes = dependencies.stepUpPurposes
    ? Object.freeze({ ...DEFAULT_STEP_UP_PURPOSES, ...(dependencies.stepUpPurposes instanceof Map ? Object.fromEntries(dependencies.stepUpPurposes) : dependencies.stepUpPurposes) })
    : DEFAULT_STEP_UP_PURPOSES;
  const createStepUp = dependencies.stepUpAuthorizationMiddlewareFactory ?? createStepUpAuthorizationMiddleware;
  const evidenceUpload = (request, _response, next) => {
    const contentType = request.get("content-type")?.split(";", 1)[0].toLowerCase();
    if (!uploadTypes.includes(contentType)) return next(new ApiError(400, "EVIDENCE_INVALID", "Evidence file is invalid"));
    return next();
  };
  const evidenceParser = express.raw({ type: uploadTypes, limit: "10mb" });
  const transactionParamsSchema = z.object({ transactionId: transactionIdSchema }).strict();
  const evidenceParamsSchema = z.object({ evidenceId: disputeIdSchema }).strict();
  const validateDisputeCreation = validateRequest({ params: transactionParamsSchema, body: disputeCreateSchema });
  const validateDisputeResponse = validateRequest({ params: disputeParamsSchema, body: disputeResponseSchema });
  const validateDisputeResource = validateRequest({ params: disputeParamsSchema });
  const validateEvidenceResource = validateRequest({ params: evidenceParamsSchema });
  const validateDisputeCreate = (request, response, next) => {
    if (!disputeIdempotencyKeySchema.safeParse(request.get("idempotency-key")).success) return next(new ApiError(400, "VALIDATION_ERROR", "Request validation failed"));
    return validateDisputeCreation(request, response, next);
  };
  const validateEvidenceMetadata = (request, _response, next) => {
    if (!evidenceCategorySchema.safeParse(request.get("x-evidence-category") ?? "").success) return next(new ApiError(400, "VALIDATION_ERROR", "Request validation failed"));
    return next();
  };
  const validateReviewResource = validateRequest({ params: disputeParamsSchema });
  const validateResolutionInput = validateRequest({ params: disputeParamsSchema, body: disputeResolutionSchema });
  const reviewStepUp = createStepUp({ purpose: "DISPUTE_REVIEW", resourceIdParam: "disputeId", purposeRegistry: purposes, getClient });
  const resolveStepUp = createStepUp({ purpose: "DISPUTE_RESOLUTION", resourceIdParam: "disputeId", purposeRegistry: purposes, getClient });
  const bindEvidenceDispute = async (request, _response, next) => {
    try {
      const prisma = await getClient();
      const evidence = await prisma.evidence.findUnique({ where: { id: request.params.evidenceId }, select: { disputeId: true } });
      if (!evidence) return next(new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found"));
      request.disputeResourceId = evidence.disputeId; return next();
    } catch { return next(new ApiError(503, "DISPUTE_SERVICE_UNAVAILABLE", "Dispute service is temporarily unavailable")); }
  };
  const adminEvidenceStepUp = createStepUp({ purpose: "DISPUTE_REVIEW", resourceId: (request) => request.disputeResourceId, purposeRegistry: purposes, getClient });

  router.post("/transactions/:transactionId/disputes", authentication, validateDisputeCreate, requireTransactionParticipant({ getClient }), controller.create);
  router.get("/disputes/:disputeId", authentication, validateDisputeResource, requireDisputeParticipant({ getClient }), controller.get);
  router.get("/admin/disputes/:disputeId", authentication, requireRoles("ADMIN"), validateReviewResource, reviewStepUp, controller.getForReview);
  router.post("/disputes/:disputeId/responses", authentication, validateDisputeResponse, requireDisputeParticipant({ getClient }), controller.respond);
  router.post("/disputes/:disputeId/evidence", authentication, validateDisputeResource, evidenceUpload, validateEvidenceMetadata, requireDisputeParticipant({ getClient }), evidenceParser, controller.uploadEvidence);
  router.get("/dispute-evidence/:evidenceId", authentication, validateEvidenceResource, requireEvidenceParticipant({ getClient }), controller.downloadEvidence(false));
  router.post("/admin/disputes/:disputeId/review", authentication, requireRoles("ADMIN"), validateReviewResource, reviewStepUp, controller.review);
  router.post("/admin/disputes/:disputeId/resolve", authentication, requireRoles("ADMIN"), validateResolutionInput, resolveStepUp, controller.resolve);
  router.get("/admin/dispute-evidence/:evidenceId", authentication, requireRoles("ADMIN"), validateEvidenceResource, bindEvidenceDispute, adminEvidenceStepUp, controller.downloadEvidence(true));
  return router;
};
