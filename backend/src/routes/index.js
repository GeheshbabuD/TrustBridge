import { Router } from "express";
import { createAuthRouter } from "./auth.routes.js";

export const registerApiRoutes = (app, dependencies = {}) => {
  const apiV1Router = Router();
  apiV1Router.use("/auth", createAuthRouter(dependencies));
  app.use("/api/v1", apiV1Router);
};
