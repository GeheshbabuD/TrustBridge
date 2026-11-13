import { Router } from "express";
import { createMarketplaceQueryController } from "../controllers/marketplace-query.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { createMarketplaceQueryService } from "../services/marketplace-query.service.js";
import { sellerLookupQuerySchema } from "../validators/marketplace-query.validator.js";
import { validateRequest } from "../middleware/validate.middleware.js";

export const createMarketplaceRouter = (dependencies = {}) => {
  const router = Router();
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const service = dependencies.marketplaceQueryService ?? createMarketplaceQueryService({ getClient: dependencies.getClient });
  const controller = createMarketplaceQueryController({ queryService: service });
  router.get("/sellers", authentication, validateRequest({ query: sellerLookupQuerySchema }), controller.searchSellers);
  return router;
};
