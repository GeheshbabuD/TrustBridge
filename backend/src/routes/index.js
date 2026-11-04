import { Router } from "express";
import { createAuthRouter } from "./auth.routes.js";
import { createUserRouter } from "./user.routes.js";
import { createTransactionRouter } from "./transaction.routes.js";
import { createPaymentRouter } from "./payment.routes.js";
import { createEscrowRouter } from "./escrow.routes.js";

export const registerApiRoutes = (app, dependencies = {}) => {
  const apiV1Router = Router();
  apiV1Router.use("/auth", createAuthRouter(dependencies));
  apiV1Router.use(createUserRouter(dependencies));
  apiV1Router.use(createTransactionRouter(dependencies));
  apiV1Router.use(createPaymentRouter(dependencies));
  apiV1Router.use(createEscrowRouter(dependencies));
  app.use("/api/v1", apiV1Router);
};
