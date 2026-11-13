import { Router } from "express";
import { createMarketplaceQueryController } from "../controllers/marketplace-query.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { createRecentMfaMiddleware } from "../middleware/recentMfa.middleware.js";
import { createSharedRateLimiter } from "../middleware/rateLimit.middleware.js";
import { createMarketplaceQueryService } from "../services/marketplace-query.service.js";
import { ApiError } from "../utils/ApiError.js";

export const createAdminRouter = (dependencies = {}) => {
  const router = Router();
  const environment = dependencies.environment;
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const service = dependencies.marketplaceQueryService ?? createMarketplaceQueryService({ getClient: dependencies.getClient });
  const controller = createMarketplaceQueryController({ queryService: service });
  const recentMfa = dependencies.recentMfaMiddleware ?? createRecentMfaMiddleware({ maxAgeSeconds: 300, getClient: dependencies.getClient });
  const limit = (operation) => {
    if (dependencies.adminReadRateLimiter) return dependencies.adminReadRateLimiter;
    if (environment?.rateLimit && dependencies.rateLimitStore) return createSharedRateLimiter({
      windowMs: environment.rateLimit.windowMs, max: environment.rateLimit.max, store: dependencies.rateLimitStore,
      keySecret: environment.rateLimit.keySecret, operation, family: "admin-read", accountScope: operation,
    });
    if (environment?.nodeEnv === "production") return (_request, _response, next) => next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."));
    return (_request, _response, next) => next();
  };

  router.get("/admin/transactions", authentication, requireRole("ADMIN"), recentMfa, limit("admin-transaction-list"), controller.listAdminTransactions);
  router.get("/admin/disputes", authentication, requireRole("ADMIN"), recentMfa, limit("admin-dispute-list"), controller.listAdminDisputes);
  return router;
};
