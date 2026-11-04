import express from "express";
import helmet from "helmet";
import { getEnv } from "./config/env.js";
import { createCorsMiddleware } from "./middleware/cors.middleware.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { notFoundHandler } from "./middleware/notFound.middleware.js";
import { createApiRateLimiter } from "./middleware/rateLimit.middleware.js";
import { createRequestLogger } from "./middleware/requestLogger.middleware.js";
import { requestIdMiddleware } from "./middleware/requestId.middleware.js";
import { registerApiRoutes } from "./routes/index.js";
import { getRateLimitStore, MemoryRateLimitStore } from "./services/rate-limit-store.service.js";
import { createMfaService } from "./services/mfa.service.js";

export const createApp = (environment = getEnv(), { writeLog, authService, sessionService, mfaService, userService, paymentService, paymentAdapter, escrowService, escrowServiceOptions, mfaEncryptionProvider, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, authRegistrationRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, rateLimitStore: injectedRateLimitStore, stepUpPurposes, stepUpAuthorizationMiddlewareFactory, verifyIndependentIdentity, deliverLegacyAdminEnrollmentAuthorization } = {}) => {
  const app = express();

  const activeMfaService = mfaService ?? ((environment.nodeEnv === "production" || mfaEncryptionProvider)
    ? createMfaService({ environment, ...(mfaEncryptionProvider ? { encryptionProvider: mfaEncryptionProvider } : {}), ...(stepUpPurposes ? { stepUpPurposes } : {}), ...(verifyIndependentIdentity ? { verifyIndependentIdentity } : {}), ...(deliverLegacyAdminEnrollmentAuthorization ? { deliverLegacyAdminEnrollmentAuthorization } : {}) })
    : undefined);

  app.set("env", environment.nodeEnv);
  app.set("trust proxy", false);
  const rateLimitStore = injectedRateLimitStore ?? (environment.nodeEnv === "test" ? new MemoryRateLimitStore() : getRateLimitStore(environment.rateLimit));
  const rateLimitOptions = {
    windowMs: environment.rateLimit.windowMs,
    max: environment.rateLimit.max,
    store: rateLimitStore,
    keySecret: environment.rateLimit.keySecret,
  };

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
    let kmsAvailable = environment.nodeEnv !== "production";
    if (activeMfaService?.checkEncryptionAvailability) {
      try { kmsAvailable = await activeMfaService.checkEncryptionAvailability(); } catch { kmsAvailable = false; }
    }
    response.status(503).json({
      success: false,
      message: "Application readiness cannot be confirmed",
      data: {
        status: "not_ready",
        checks: { database: "not_checked", rateLimitStore: rateLimitHealth.available ? (rateLimitHealth.shared ? "available" : "process_local") : "unavailable", mfaEncryption: environment.nodeEnv === "production" ? (kmsAvailable ? "available" : "unavailable") : "not_required" },
      },
      error: { code: "READINESS_UNAVAILABLE" },
      requestId: request.requestId,
    });
  });

  registerApiRoutes(app, { environment, authService, sessionService, mfaService: activeMfaService, userService, paymentService, paymentAdapter, escrowService, escrowServiceOptions, mfaEncryptionProvider, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, authRegistrationRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, rateLimitStore, stepUpPurposes, stepUpAuthorizationMiddlewareFactory, verifyIndependentIdentity, deliverLegacyAdminEnrollmentAuthorization });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

const app = createApp();

export default app;
