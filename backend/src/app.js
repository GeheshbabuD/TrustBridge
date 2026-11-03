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

export const createApp = (environment = getEnv(), { writeLog, authService, sessionService, mfaService, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, stepUpPurposes } = {}) => {
  const app = express();

  app.set("env", environment.nodeEnv);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(requestIdMiddleware);
  app.use(createRequestLogger({ writeLog }));
  app.use(createCorsMiddleware(environment.corsAllowedOrigins));
  app.use(express.json({ limit: "1mb" }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: "1mb",
      parameterLimit: 1000,
    }),
  );

  // Only versioned API traffic is limited; /health remains available to probes.
  app.use("/api/v1", createApiRateLimiter(environment.rateLimit));

  const livenessHandler = (_request, response) => {
    response.status(200).json({
      success: true,
      message: "TrustBridge backend is running",
      data: { status: "healthy" },
    });
  };

  app.get("/health", livenessHandler);
  app.get("/health/live", livenessHandler);
  app.get("/health/ready", (request, response) => {
    response.status(503).json({
      success: false,
      message: "Application readiness cannot be confirmed",
      data: {
        status: "not_ready",
        checks: { database: "not_checked" },
      },
      error: { code: "READINESS_UNAVAILABLE" },
      requestId: request.requestId,
    });
  });

  registerApiRoutes(app, { environment, authService, sessionService, mfaService, authenticationMiddleware, mfaVerificationRateLimiter, authLoginRateLimiter, mfaChallengeRateLimiter, mfaStepUpCreateRateLimiter, mfaStepUpVerifyRateLimiter, stepUpPurposes });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

const app = createApp();

export default app;
