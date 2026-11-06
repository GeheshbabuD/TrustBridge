import express, { Router } from "express";
import { createTransactionController } from "../controllers/transaction.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { requireTransactionParticipant } from "../middleware/ownership.middleware.js";
import { createTransactionService } from "../services/transaction.service.js";
import { createTransactionDeliveryService } from "../services/transaction-delivery.service.js";
import { ApiError } from "../utils/ApiError.js";

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
  const evidenceParser = express.raw({ type: evidenceTypes, limit: "10mb" });
  const evidenceContentType = (request, _response, next) => evidenceTypes.includes(request.get("content-type")?.split(";", 1)[0].toLowerCase())
    ? next() : next(new ApiError(400, "EVIDENCE_INVALID", "Evidence file is invalid"));

  router.post("/transactions", authentication, requireRole("USER"), controller.create);
  router.get("/transactions", authentication, controller.list);
  router.post("/transaction-invitations/accept", authentication, controller.respondToInvitation("ACCEPTED"));
  router.post("/transaction-invitations/reject", authentication, controller.respondToInvitation("REJECTED"));
  router.get("/transactions/:transactionId", authentication, participant, controller.get);
  router.get("/transactions/:transactionId/history", authentication, participant, controller.history);
  router.get("/transactions/:transactionId/terms", authentication, participant, controller.getTerms);
  router.post("/transactions/:transactionId/terms/versions", authentication, participant, controller.proposeTerms);
  router.post("/transactions/:transactionId/terms/decisions", authentication, participant, controller.decideTerms);
  router.post("/transactions/:transactionId/invitations", authentication, requireTransactionParticipant({ getClient: dependencies.getClient, idParam: "transactionId", roles: ["BUYER"] }), controller.createInvitation);
  router.post("/transactions/:transactionId/transitions", authentication, participant, controller.transition);
  router.post("/transactions/:transactionId/work/start", authentication, participant, controller.startWork);
  router.post("/transactions/:transactionId/deliveries", authentication, participant, controller.submitDelivery);
  router.get("/transactions/:transactionId/deliveries", authentication, participant, controller.deliveryHistory);
  router.post("/transactions/:transactionId/deliveries/decision", authentication, participant, controller.decideDelivery);
  router.post("/transactions/:transactionId/deliveries/:deliveryId/evidence", authentication, participant, evidenceContentType, evidenceParser, controller.uploadDeliveryEvidence);
  router.get("/transaction-delivery-evidence/:evidenceId", authentication, controller.downloadDeliveryEvidence);
  return router;
};
