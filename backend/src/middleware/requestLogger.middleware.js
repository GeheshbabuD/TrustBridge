import { writeStructuredLog } from "../utils/logger.js";

export const createRequestLogger = ({ writeLog = writeStructuredLog } = {}) =>
  (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    let logged = false;

    response.once("finish", () => {
      if (logged) return;
      logged = true;

      try {
        const matchedRoute = request.route?.path;
        writeLog({
          timestamp: new Date().toISOString(),
          level: response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info",
          event: "http_request_complete",
          requestId: request.requestId,
          method: request.method,
          route: typeof matchedRoute === "string" ? matchedRoute : "unmatched",
          status: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        });
      } catch {
        // Logging is best-effort and must not affect the completed response.
      }
    });

    next();
  };
