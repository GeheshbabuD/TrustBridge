import { Router } from "express";
import { createNotificationController } from "../controllers/notification.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireOwnNotification } from "../middleware/ownership.middleware.js";
import { createNotificationService } from "../services/notification.service.js";
import { validateRequest } from "../middleware/validate.middleware.js";
import { notificationIdSchema } from "../validators/notification.validator.js";
import { z } from "zod";

export const createNotificationRouter = (dependencies = {}) => {
  const router = Router();
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const getClient = dependencies.getClient;
  const service = dependencies.notificationService ?? createNotificationService({ getClient, emailAdapter: dependencies.emailAdapter });
  const controller = createNotificationController({ notificationService: service });
  const validateNotificationResource = validateRequest({ params: z.object({ notificationId: notificationIdSchema }).strict() });
  router.get("/notifications", authentication, controller.listMine);
  router.patch("/notifications/:notificationId/read", authentication, validateNotificationResource, requireOwnNotification({ getClient }), controller.markRead);
  return router;
};
