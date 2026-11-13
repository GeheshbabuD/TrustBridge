import express, { Router } from "express";
import { createTransactionController } from "../controllers/transaction.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { requireTransactionParticipant } from "../middleware/ownership.middleware.js";
import { createTransactionService } from "../services/transaction.service.js";
import { createTransactionDeliveryService } from "../services/transaction-delivery.service.js";
import { ApiError } from "../utils/ApiError.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.middleware.js";
import { evidenceCategorySchema, transactionIdSchema } from "../validators/dispute.validator.js";
import { deliveryDecisionSchema, deliveryStartSchema, deliverySubmitSchema, transactionHistoryQuerySchema, transactionInvitationCreateSchema, transactionTermsDecisionSchema, transactionTermsProposalSchema, transactionTransitionSchema } from "../validators/transaction.validator.js";

export const createTransactionRouter = (dependencies = {}) => {
  const router = Router();
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const service = dependencies.transactionService ?? createTransactionService(dependencies.transactionServiceOptions);
  const deliveryService = dependencies.transactionDeliveryService ?? createTransactionDeliveryService({ getClient: dependencies.getClient, storage: dependencies.evidenceStorage });
  const controller = createTransactionController({ transactionService: service, deliveryService });
  const participant = requireTransactionParticipant({
    getClient: dependencies.getClient,
    idParam: "transactionId",
  });
  const evidenceTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  const transactionParamsSchema = z.object({ transactionId: transactionIdSchema }).strict();
  const deliveryEvidenceParamsSchema = z.object({ transactionId: transactionIdSchema, deliveryId: transactionIdSchema }).strict();
  const validateTransactionParams = validateRequest({ params: transactionParamsSchema });
  const validateHistoryRequest = validateRequest({ params: transactionParamsSchema, query: transactionHistoryQuerySchema });
  const validateTransactionBody = (schema) => validateRequest({ params: transactionParamsSchema, body: schema });
  const validateDeliveryEvidenceParams = validateRequest({ params: deliveryEvidenceParamsSchema });
  const evidenceCategory = (request, _response, next) => evidenceCategorySchema.safeParse(request.get("x-evidence-category") ?? "").success
    ? next() : next(new ApiError(400, "VALIDATION_ERROR", "Request validation failed"));
  const evidenceParser = express.raw({ type: evidenceTypes, limit: "10mb" });
  const evidenceContentType = (request, _response, next) => evidenceTypes.includes(request.get("content-type")?.split(";", 1)[0].toLowerCase())
    ? next() : next(new ApiError(400, "EVIDENCE_INVALID", "Evidence file is invalid"));

  router.post("/transactions", authentication, requireRole("USER"), controller.create);
  router.get("/transactions", authentication, controller.list);
  router.post("/transaction-invitations/accept", authentication, controller.respondToInvitation("ACCEPTED"));
  router.post("/transaction-invitations/reject", authentication, controller.respondToInvitation("REJECTED"));
  router.get("/transactions/:transactionId", authentication, validateTransactionParams, participant, controller.get);
  router.get("/transactions/:transactionId/history", authentication, validateHistoryRequest, participant, controller.history);
  router.get("/transactions/:transactionId/terms", authentication, validateTransactionParams, participant, controller.getTerms);
  router.post("/transactions/:transactionId/terms/versions", authentication, validateTransactionBody(transactionTermsProposalSchema), participant, controller.proposeTerms);
  router.post("/transactions/:transactionId/terms/decisions", authentication, validateTransactionBody(transactionTermsDecisionSchema), participant, controller.decideTerms);
  router.post("/transactions/:transactionId/invitations", authentication, validateTransactionBody(transactionInvitationCreateSchema), requireTransactionParticipant({ getClient: dependencies.getClient, idParam: "transactionId", roles: ["BUYER"] }), controller.createInvitation);
  router.post("/transactions/:transactionId/transitions", authentication, validateTransactionBody(transactionTransitionSchema), participant, controller.transition);
  router.post("/transactions/:transactionId/work/start", authentication, validateTransactionBody(deliveryStartSchema), participant, controller.startWork);
  router.post("/transactions/:transactionId/deliveries", authentication, validateTransactionBody(deliverySubmitSchema), participant, controller.submitDelivery);
  router.get("/transactions/:transactionId/deliveries", authentication, validateTransactionParams, participant, controller.deliveryHistory);
  router.post("/transactions/:transactionId/deliveries/decision", authentication, validateTransactionBody(deliveryDecisionSchema), participant, controller.decideDelivery);
  router.post("/transactions/:transactionId/deliveries/:deliveryId/evidence", authentication, validateDeliveryEvidenceParams, evidenceContentType, evidenceCategory, participant, evidenceParser, controller.uploadDeliveryEvidence);
  router.get("/transaction-delivery-evidence/:evidenceId", authentication, controller.downloadDeliveryEvidence);
  return router;
};
