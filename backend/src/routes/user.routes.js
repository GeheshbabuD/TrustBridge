import { Router } from "express";
import { createUserController } from "../controllers/user.controller.js";
import { createUserService } from "../services/user.service.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { createRecentMfaMiddleware, createStepUpAuthorizationMiddleware } from "../middleware/recentMfa.middleware.js";
import { DEFAULT_STEP_UP_PURPOSES } from "../services/step-up-purpose.registry.js";

export const createUserRouter = (dependencies = {}) => {
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const userService = dependencies.userService ?? createUserService(dependencies.userServiceOptions);
  const controller = createUserController({ userService });
  const registry = dependencies.stepUpPurposes
    ? Object.freeze({ ...DEFAULT_STEP_UP_PURPOSES, ...(dependencies.stepUpPurposes instanceof Map ? Object.fromEntries(dependencies.stepUpPurposes) : dependencies.stepUpPurposes) })
    : DEFAULT_STEP_UP_PURPOSES;
  const createStepUp = dependencies.stepUpAuthorizationMiddlewareFactory ?? createStepUpAuthorizationMiddleware;
  const requireAdminRecentMfa = createRecentMfaMiddleware({ maxAgeSeconds: 300 });
  const deactivateStepUp = createStepUp({ purpose: "USER_ACCOUNT_DEACTIVATE", resourceId: (request) => request.auth?.userId, purposeRegistry: registry });
  const passwordStepUp = createStepUp({ purpose: "USER_PASSWORD_CHANGE", resourceId: (request) => request.auth?.userId, purposeRegistry: registry });
  const adminStatusStepUp = createStepUp({ purpose: "ADMIN_USER_STATUS_UPDATE", resourceId: (request) => request.params.userId, purposeRegistry: registry });
  const conditionalDeactivationStepUp = (request, response, next) => request.auth?.mfaEnabled ? deactivateStepUp(request, response, next) : next();
  const conditionalPasswordStepUp = (request, response, next) => request.auth?.mfaEnabled ? passwordStepUp(request, response, next) : next();

  const router = Router();
  router.get("/users/me", authentication, controller.getMe);
  router.patch("/users/me", authentication, controller.updateMe);
  router.post("/users/me/password", authentication, controller.validatePasswordChange, controller.verifyPasswordChangePassword, conditionalPasswordStepUp, controller.changePassword);
  router.post("/users/me/deactivate", authentication, controller.validateDeactivation, controller.verifyDeactivationPassword, conditionalDeactivationStepUp, controller.deactivateMe);

  router.get("/admin/users", authentication, requireRole("ADMIN"), requireAdminRecentMfa, controller.listAdminUsers);
  router.get("/admin/users/:userId", authentication, requireRole("ADMIN"), requireAdminRecentMfa, controller.getAdminUser);
  router.patch("/admin/users/:userId/status", authentication, requireRole("ADMIN"), controller.validateAdminStatus, adminStatusStepUp, controller.updateAdminUserStatus);
  return router;
};
