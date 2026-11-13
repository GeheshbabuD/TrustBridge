import { recordOutboxBatchMetrics, recordWorkerRunMetrics, recordWorkerStateMetrics } from "../services/operational-metrics.adapter.js";

/** Supervised bounded blockchain commitment and reconciliation worker. */
export const createBlockchainOutboxWorker = ({ blockchainService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!blockchainService || typeof blockchainService.processOutboxBatch !== "function" || typeof blockchainService.reconcilePending !== "function") throw new TypeError("Blockchain worker requires blockchain service");
  let timer = null; let active = null; let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  let onStatusChange = () => {}; let metrics; let collectOutboxMetrics;
  const setState = (state) => { if (status.state === state) return; const previous = status.state; status.state = state; recordWorkerStateMetrics(metrics, "blockchain", previous, state); try { onStatusChange(Object.freeze({ ...status })); } catch { /* Observers cannot interrupt blockchain processing. */ } };
  const worker = {
    async runOnce({ limit = 20 } = {}) { const processing = await blockchainService.processOutboxBatch({ limit }); const reconciliation = await blockchainService.reconcilePending({ limit }); return { processing, reconciliation }; },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 15_000, limit = 20, onStatusChange: observeStatus, metrics: observeMetrics, collectOutboxMetrics: collectMetrics } = {}) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 300_000) throw new RangeError("Invalid blockchain worker interval");
      if (timer) return worker.stop;
      onStatusChange = typeof observeStatus === "function" ? observeStatus : () => {};
      metrics = observeMetrics; collectOutboxMetrics = collectMetrics;
      stopping = false; setState("running");
      const tick = () => { if (stopping || active) return; const startedAt = Date.now(); active = worker.runOnce({ limit }).then((result) => { recordWorkerRunMetrics(metrics, "blockchain", "success", Date.now() - startedAt); recordOutboxBatchMetrics(metrics, "blockchain", result); status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) setState("running"); }).catch(() => { recordWorkerRunMetrics(metrics, "blockchain", "failure", Date.now() - startedAt); status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) setState("degraded"); }).finally(() => { active = null; void Promise.resolve().then(() => collectOutboxMetrics?.collect()).catch(() => {}); }); };
      tick(); timer = setIntervalFn(tick, intervalMs); timer.unref?.(); return worker.stop;
    },
    async stop() { stopping = true; setState("stopping"); if (timer) clearIntervalFn(timer); timer = null; if (active) await active; setState("stopped"); },
  };
  return Object.freeze(worker);
};
