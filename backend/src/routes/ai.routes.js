import { Router } from "express";
import { createAiController } from "../controllers/ai.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import { createRecentMfaMiddleware } from "../middleware/recentMfa.middleware.js";
import { createSharedRateLimiter } from "../middleware/rateLimit.middleware.js";
import { createJsonAiAdapter } from "../services/ai-provider.adapter.js";
import { createAiService } from "../services/ai.service.js";
import { createRiskBaselineService } from "../services/risk-baseline.service.js";
import { createAiDisputeService } from "../services/ai-dispute.service.js";
import { createStepUpAuthorizationMiddleware } from "../middleware/recentMfa.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { disputeAssistanceParamsSchema, emptyRequestBodySchema } from "../validators/ai.validator.js";
import { validateRequest } from "../middleware/validate.middleware.js";

export const createAiRouter = (dependencies = {}) => {
  const router = Router();
  const environment = dependencies.environment;
  const config = environment?.integrations?.ai;
  const adapter = dependencies.aiAdapter ?? (config?.enabled ? createJsonAiAdapter({ provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, modelIdentifier: config.modelIdentifier, modelVersion: config.modelVersion, timeoutMs: config.requestTimeoutMs }) : undefined);
  const service = dependencies.aiService ?? createAiService({ getClient: dependencies.getClient, adapter, enabled: config?.enabled === true, provider: config?.provider, modelIdentifier: config?.modelIdentifier, modelVersion: config?.modelVersion });
  const controller = createAiController({ aiService: service });
  const baselineService = dependencies.riskBaselineService ?? createRiskBaselineService({ getClient: dependencies.getClient });
  const baselineController = createAiController({ aiService: baselineService });
  const disputeService = dependencies.aiDisputeService ?? createAiDisputeService({ getClient: dependencies.getClient, adapter, enabled: config?.enabled === true, provider: config?.provider, modelIdentifier: config?.modelIdentifier, modelVersion: config?.modelVersion });
  const disputeController = createAiController({ aiService: disputeService });
  const authentication = dependencies.authenticationMiddleware ?? requireAuthentication;
  const limiter = dependencies.aiRateLimiter ?? (environment?.rateLimit && dependencies.rateLimitStore && config?.rateLimit
    ? createSharedRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max, store: dependencies.rateLimitStore, keySecret: environment.rateLimit.keySecret, operation: "transaction-risk-assessment", family: "ai-risk", accountScope: "ai-risk-assessment" })
    : environment?.nodeEnv === "production"
      ? (_request, _response, next) => next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."))
      : (_request, _response, next) => next());
  const recentMfa = dependencies.recentMfaMiddleware ?? createRecentMfaMiddleware({ maxAgeSeconds: 300, getClient: dependencies.getClient });
  const baselineLimiter = dependencies.riskBaselineRateLimiter ?? dependencies.aiRateLimiter ?? (environment?.rateLimit && dependencies.rateLimitStore && config?.rateLimit
    ? createSharedRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max, store: dependencies.rateLimitStore, keySecret: environment.rateLimit.keySecret, operation: "transaction-risk-baseline", family: "ai-risk", accountScope: "ai-risk-baseline" })
    : environment?.nodeEnv === "production"
      ? (_request, _response, next) => next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."))
      : (_request, _response, next) => next());
  const disputeLimiter = dependencies.disputeAssistanceRateLimiter ?? (environment?.rateLimit && dependencies.rateLimitStore && config?.rateLimit
    ? createSharedRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max, store: dependencies.rateLimitStore, keySecret: environment.rateLimit.keySecret, operation: "dispute-ai-assistance", family: "ai-risk", accountScope: "dispute-assistance" })
    : environment?.nodeEnv === "production"
      ? (_request, _response, next) => next(new ApiError(503, "RATE_LIMIT_STORE_UNAVAILABLE", "Request protection is temporarily unavailable."))
      : (_request, _response, next) => next());
  const disputeStepUp = dependencies.disputeAssistanceStepUpMiddleware ?? createStepUpAuthorizationMiddleware({ purpose: "DISPUTE_REVIEW", resourceIdParam: "disputeId", getClient: dependencies.getClient });
  const validateDisputeAssistanceInput = validateRequest({ params: disputeAssistanceParamsSchema, body: emptyRequestBodySchema });

  router.post("/admin/transactions/:transactionId/risk-assessments", authentication, limiter, requireRole("ADMIN"), recentMfa, controller.assessTransactionRisk);
  router.post("/admin/transactions/:transactionId/risk-baselines", authentication, baselineLimiter, requireRole("ADMIN"), recentMfa, baselineController.assessTransactionRiskBaseline);
  router.post("/admin/disputes/:disputeId/assistance", authentication, disputeLimiter, requireRole("ADMIN"), validateDisputeAssistanceInput, disputeStepUp, disputeController.assessDispute);
  return router;
};
