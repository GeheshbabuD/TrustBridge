import { writeStructuredLog } from "../utils/logger.js";

const alertTypes = new Set(["WORKER_UNAVAILABLE", "WORKER_RECOVERED"]);
const workerNames = new Set(["notification", "escrow", "blockchain"]);
const workerStates = new Set(["starting", "running", "degraded", "stopping", "stopped", "failed", "drain_timeout", "disabled", "unknown"]);
const errorCodes = new Set(["WORKER_RUN_FAILED", "WORKER_START_FAILED", "WORKER_STOP_FAILED", "DRAIN_TIMEOUT"]);

const sanitizeAlert = (alert) => {
  if (!alert || !alertTypes.has(alert.type) || !workerNames.has(alert.worker) || !workerStates.has(alert.state)) return null;
  return Object.freeze({
    type: alert.type,
    worker: alert.worker,
    state: alert.state,
    required: alert.required === true,
    timestamp: typeof alert.timestamp === "string" ? alert.timestamp : new Date().toISOString(),
    ...(errorCodes.has(alert.lastErrorCode) ? { lastErrorCode: alert.lastErrorCode } : {}),
  });
};

/** Provider-neutral worker alert boundary. The default sink is a safe structured log. */
export const createOperationalAlertAdapter = ({ send, writeLog = writeStructuredLog } = {}) => {
  if (send !== undefined && typeof send !== "function") throw new TypeError("Operational alert sender must be a function");
  if (typeof writeLog !== "function") throw new TypeError("Operational alert logger must be a function");
  return Object.freeze({
    async notify(alert) {
      const safe = sanitizeAlert(alert);
      if (!safe) return false;
      if (!send) {
        try { writeLog({ timestamp: safe.timestamp, level: safe.type === "WORKER_UNAVAILABLE" ? "error" : "info", event: "worker_operational_alert", ...safe }); }
        catch { /* Observability must not interrupt worker execution. */ }
        return true;
      }
      try {
        await send(safe);
        return true;
      } catch {
        try { writeLog({ timestamp: safe.timestamp, level: "error", event: "operational_alert_delivery_failed", worker: safe.worker, type: safe.type, required: safe.required, errorCode: "ALERT_DELIVERY_FAILED" }); }
        catch { /* Alert and fallback logger failures are isolated from the application. */ }
        return false;
      }
    },
  });
};
