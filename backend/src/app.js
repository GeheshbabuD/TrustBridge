import express from "express";
import helmet from "helmet";
import { getEnv } from "./config/env.js";
import { connectDatabase, getPrismaClient } from "./config/db.js";
import { createCorsMiddleware } from "./middleware/cors.middleware.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { notFoundHandler } from "./middleware/notFound.middleware.js";
import { createApiRateLimiter } from "./middleware/rateLimit.middleware.js";
import { createRequestLogger } from "./middleware/requestLogger.middleware.js";
import { requestIdMiddleware } from "./middleware/requestId.middleware.js";
import { registerApiRoutes } from "./routes/index.js";
import { getRateLimitStore, MemoryRateLimitStore } from "./services/rate-limit-store.service.js";
import { createMfaService } from "./services/mfa.service.js";
import { composeEscrowRuntime } from "./services/escrow-runtime.composition.js";
import { createEscrowOutboxWorker } from "./workers/escrow-outbox.worker.js";
import { createNotificationService } from "./services/notification.service.js";
import { createNotificationOutboxWorker } from "./workers/notification-outbox.worker.js";
import { createBlockchainService } from "./services/blockchain.service.js";
import { createBlockchainOutboxWorker } from "./workers/blockchain-outbox.worker.js";
import { createEthersBlockchainAdapter } from "./services/ethers-blockchain.adapter.js";
import { createOperationalMetricsAdapter, createOutboxMetricsCollector } from "./services/operational-metrics.adapter.js";

export const createApp = (environment = getEnv(), { writeLog, authService, sessionService, mfaService, userService, notificationService, emailAdapter, paymentService, paymentAdapter, escrowService, escrowServiceOptions, resolveRouteAccount, disputeService, evidenceStorage, aiService, aiAdapter, blockchainAdapter, blockchainSigner, blockchainService, aiRateLimiter, recentMfaMiddleware, mfaEncryptionProvider, operationalAlertAdapter, operationalMetrics, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, authRegistrationRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, rateLimitStore: injectedRateLimitStore, stepUpPurposes, stepUpAuthorizationMiddlewareFactory, verifyIndependentIdentity, deliverLegacyAdminEnrollmentAuthorization, checkDatabase = connectDatabase } = {}) => {
  const app = express();

  const activeMfaService = mfaService ?? ((environment.nodeEnv === "production" || mfaEncryptionProvider)
    ? createMfaService({ environment, ...(mfaEncryptionProvider ? { encryptionProvider: mfaEncryptionProvider } : {}), ...(stepUpPurposes ? { stepUpPurposes } : {}), ...(verifyIndependentIdentity ? { verifyIndependentIdentity } : {}), ...(deliverLegacyAdminEnrollmentAuthorization ? { deliverLegacyAdminEnrollmentAuthorization } : {}) })
    : undefined);

  app.set("env", environment.nodeEnv);
  app.set("trust proxy", false);
  if (operationalAlertAdapter !== undefined) app.locals.operationalAlertAdapter = operationalAlertAdapter;
  const activeOperationalMetrics = operationalMetrics ?? createOperationalMetricsAdapter();
  for (const method of ["increment", "gauge", "observe", "snapshot"]) if (typeof activeOperationalMetrics[method] !== "function") throw new TypeError("Operational metrics adapter is invalid");
  app.locals.operationalMetrics = activeOperationalMetrics;
  app.locals.collectOutboxMetrics = createOutboxMetricsCollector({ getClient: getPrismaClient, metrics: activeOperationalMetrics });
  const rateLimitStore = injectedRateLimitStore ?? (environment.nodeEnv === "test" ? new MemoryRateLimitStore() : getRateLimitStore(environment.rateLimit));
  const rateLimitOptions = {
    windowMs: environment.rateLimit.windowMs,
    max: environment.rateLimit.max,
    store: rateLimitStore,
    keySecret: environment.rateLimit.keySecret,
  };
  const escrowRuntime = composeEscrowRuntime({
    paymentConfig: environment.integrations?.payment,
    paymentAdapter, escrowService, escrowServiceOptions, resolveRouteAccount,
  });
  const blockchainConfig = environment.integrations?.blockchain;
  if (blockchainConfig?.enabled && !blockchainAdapter && !blockchainSigner && !blockchainService) throw new Error("Blockchain is enabled but no approved signing adapter is configured");
  const activeBlockchainAdapter = blockchainAdapter ?? (blockchainConfig?.enabled && blockchainSigner
    ? createEthersBlockchainAdapter({ rpcUrl: blockchainConfig.rpcUrl, chainId: blockchainConfig.chainId, contractAddress: blockchainConfig.contractAddress, confirmations: blockchainConfig.confirmations, signer: blockchainSigner })
    : undefined);
  const activeBlockchainService = blockchainService ?? (blockchainConfig?.enabled
    ? createBlockchainService({ adapter: activeBlockchainAdapter, enabled: true, network: String(blockchainConfig.chainId), contractReference: blockchainConfig.contractAddress })
    : null);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestIdMiddleware);
  app.use(createRequestLogger({ writeLog }));
  app.use(createCorsMiddleware(environment.corsAllowedOrigins));
  app.use(express.json({ limit: "1mb", verify(request, _response, buffer) {
    if (/^\/api\/v1\/webhooks\/[a-z0-9][a-z0-9._-]*$/i.test(request.originalUrl.split("?", 1)[0])) request.rawBody = Buffer.from(buffer);
  } }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: "1mb",
      parameterLimit: 1000,
    }),
  );

  // Only versioned API traffic is limited; /health remains available to probes.
  app.use("/api/v1", createApiRateLimiter(rateLimitOptions));

  const livenessHandler = (_request, response) => {
    response.status(200).json({
      success: true,
      message: "TrustBridge backend is running",
      data: { status: "healthy" },
    });
  };

  app.get("/health", livenessHandler);
  app.get("/health/live", livenessHandler);
  app.get("/health/ready", async (request, response) => {
    const rateLimitHealth = await rateLimitStore.healthCheck().catch(() => ({ available: false, shared: rateLimitStore.shared === true }));
    let databaseAvailable = false;
    try { databaseAvailable = (await checkDatabase()) !== false; } catch { /* readiness output is intentionally sanitized */ }
    let kmsAvailable = environment.nodeEnv !== "production";
    if (activeMfaService?.checkEncryptionAvailability) {
      try { kmsAvailable = await activeMfaService.checkEncryptionAvailability(); } catch { kmsAvailable = false; }
    }
    const workerStatus = Object.fromEntries(["notificationWorker", "escrowWorker", "blockchainWorker"].map((key) => {
      const worker = app.locals[key];
      if (!worker) return [key.replace("Worker", ""), {
        state: "disabled",
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorCode: null,
        required: false,
      }];
      const lifecycleWorker = app.locals.lifecycleStatus?.workers?.[key.replace("Worker", "")];
      let value;
      try {
        value = lifecycleWorker?.state === "failed" || lifecycleWorker?.state === "drain_timeout"
          ? lifecycleWorker : (typeof worker.getStatus === "function" ? worker.getStatus() : lifecycleWorker ?? { state: "unknown" });
      } catch { value = { state: "unknown" }; }
      return [key.replace("Worker", ""), {
        state: ["running", "degraded", "stopping", "stopped", "failed", "drain_timeout", "disabled"].includes(value.state) ? value.state : "unknown",
        consecutiveFailures: Number.isSafeInteger(value.consecutiveFailures) && value.consecutiveFailures >= 0 ? value.consecutiveFailures : 0,
        lastSuccessAt: typeof value.lastSuccessAt === "string" ? value.lastSuccessAt : null,
        lastFailureAt: typeof value.lastFailureAt === "string" ? value.lastFailureAt : null,
        lastErrorCode: ["WORKER_RUN_FAILED", "WORKER_START_FAILED", "WORKER_STOP_FAILED", "DRAIN_TIMEOUT"].includes(value.lastErrorCode) ? value.lastErrorCode : null,
        required: lifecycleWorker ? lifecycleWorker.required === true : key === "escrowWorker" && Boolean(worker),
      }];
    }));
    const requiredWorkersHealthy = Object.values(workerStatus).every((worker) => !worker.required || worker.state === "running");
    const checks = {
      database: databaseAvailable ? "available" : "unavailable",
      rateLimitStore: rateLimitHealth.available ? (rateLimitHealth.shared ? "available" : "process_local") : "unavailable",
      mfaEncryption: environment.nodeEnv === "production" ? (kmsAvailable ? "available" : "unavailable") : "not_required",
    };
    const ready = databaseAvailable && rateLimitHealth.available && requiredWorkersHealthy
      && (environment.nodeEnv !== "production" || (rateLimitHealth.shared === true && kmsAvailable));
    response.status(ready ? 200 : 503).json({
      success: ready,
      message: ready ? "Application is ready" : "Application readiness cannot be confirmed",
      data: {
        status: ready ? "ready" : "not_ready",
        checks,
        lifecycle: ["starting", "running", "draining", "drain_timeout", "shutdown_failed", "stopped"].includes(app.locals.lifecycleStatus?.state)
          ? app.locals.lifecycleStatus.state : "unmanaged",
        workers: workerStatus,
      },
      ...(ready ? {} : { error: { code: "READINESS_UNAVAILABLE" } }),
      requestId: request.requestId,
    });
  });

  const activeNotificationService = notificationService ?? createNotificationService({ emailAdapter });
  registerApiRoutes(app, { environment, authService, sessionService, mfaService: activeMfaService, userService, notificationService: activeNotificationService, emailAdapter, paymentService, paymentAdapter: escrowRuntime.adapter ?? paymentAdapter, escrowService: escrowRuntime.escrowService, disputeService, evidenceStorage, aiService, aiAdapter, aiRateLimiter, recentMfaMiddleware, resolveRouteAccount, mfaEncryptionProvider, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, authRegistrationRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, rateLimitStore, stepUpPurposes, stepUpAuthorizationMiddlewareFactory, verifyIndependentIdentity, deliverLegacyAdminEnrollmentAuthorization });

  app.locals.escrowWorker = escrowRuntime.workerEnabled
    ? createEscrowOutboxWorker({ escrowService: escrowRuntime.escrowService })
    : null;
  app.locals.notificationWorker = createNotificationOutboxWorker({ notificationService: activeNotificationService });
  app.locals.blockchainWorker = activeBlockchainService ? createBlockchainOutboxWorker({ blockchainService: activeBlockchainService }) : null;

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

// Retain the convenience default for local/test consumers. Production must use
// startConfiguredServer so deployment-owned adapters are injected first.
const defaultApp = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" ? createApp() : undefined;
export default defaultApp;

