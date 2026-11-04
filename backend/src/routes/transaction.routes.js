import { Router } from "express";
import { createTransactionController } from "../controllers/transaction.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { requireTransactionParticipant } from "../middleware/ownership.middleware.js";
import { createTransactionService } from "../services/transaction.service.js";

export const createTransactionRouter = (dependencies = {}) => {
  const router = Router();
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const service = dependencies.transactionService ?? createTransactionService(dependencies.transactionServiceOptions);
  const controller = createTransactionController({ transactionService: service });
  const participant = requireTransactionParticipant({
    getClient: dependencies.getClient,
    idParam: "transactionId",
  });

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
  return router;
};
