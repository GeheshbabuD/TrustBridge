import { recordOutboxBatchMetrics, recordWorkerRunMetrics, recordWorkerStateMetrics } from "../services/operational-metrics.adapter.js";

/** Supervised timer around the shared-database leased notification outbox. */
export const createNotificationOutboxWorker = ({ notificationService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!notificationService || typeof notificationService.processOutboxBatch !== "function") throw new TypeError("Notification worker requires notification service");
  let timer = null; let active = null; let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  let onStatusChange = () => {}; let metrics; let collectOutboxMetrics;
  const setState = (state) => { if (status.state === state) return; const previous = status.state; status.state = state; recordWorkerStateMetrics(metrics, "notification", previous, state); try { onStatusChange(Object.freeze({ ...status })); } catch { /* Observers cannot interrupt delivery. */ } };
  const worker = {
    async runOnce({ limit = 20 } = {}) { return notificationService.processOutboxBatch({ limit }); },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 3000, limit = 20, onStatusChange: observeStatus, metrics: observeMetrics, collectOutboxMetrics: collectMetrics } = {}) {
      if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new RangeError("Invalid notification worker interval");
      if (timer) return worker.stop;
      onStatusChange = typeof observeStatus === "function" ? observeStatus : () => {};
      metrics = observeMetrics; collectOutboxMetrics = collectMetrics;
      stopping = false; setState("running");
      const tick = () => { if (stopping || active) return; const startedAt = Date.now(); active = worker.runOnce({ limit }).then((result) => { recordWorkerRunMetrics(metrics, "notification", "success", Date.now() - startedAt); recordOutboxBatchMetrics(metrics, "notification", result); status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) setState("running"); }).catch(() => { recordWorkerRunMetrics(metrics, "notification", "failure", Date.now() - startedAt); status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) setState("degraded"); }).finally(() => { active = null; void Promise.resolve().then(() => collectOutboxMetrics?.collect()).catch(() => {}); }); };
      tick(); timer = setIntervalFn(tick, intervalMs); timer.unref?.(); return worker.stop;
    },
    async stop() { stopping = true; setState("stopping"); if (timer) clearIntervalFn(timer); timer = null; if (active) await active; setState("stopped"); },
  };
  return Object.freeze(worker);
};
