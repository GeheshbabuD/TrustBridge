import cors from "cors";
import { ApiError } from "../utils/ApiError.js";

export const createCorsMiddleware = (allowedOrigins) =>
  cors({
    origin(origin, callback) {
      // Requests without Origin are not browser CORS requests (e.g. health probes).
      if (!origin) return callback(null, false);
      if (allowedOrigins.includes(origin)) return callback(null, origin);

      return callback(
        new ApiError(403, "CORS_ORIGIN_DENIED", "Origin is not allowed"),
      );
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Request-Id",
    ],
    exposedHeaders: ["X-Request-Id"],
    credentials: false,
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
