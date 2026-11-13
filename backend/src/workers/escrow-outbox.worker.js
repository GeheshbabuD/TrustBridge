import { recordOutboxBatchMetrics, recordWorkerRunMetrics, recordWorkerStateMetrics } from "../services/operational-metrics.adapter.js";

/** One bounded worker tick; invoke from the deployment's supervised scheduler. */
export const createEscrowOutboxWorker = ({ escrowService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!escrowService || typeof escrowService.processOutboxBatch !== "function" || typeof escrowService.reconcilePendingOperations !== "function") {
    throw new TypeError("Escrow worker requires the escrow execution service");
  }
  let timer = null;
  let activeRun = null;
  let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  let onStatusChange = () => {}; let metrics; let collectOutboxMetrics;
  const setState = (state) => { if (status.state === state) return; const previous = status.state; status.state = state; recordWorkerStateMetrics(metrics, "escrow", previous, state); try { onStatusChange(Object.freeze({ ...status })); } catch { /* Observers cannot interrupt financial processing. */ } };
  const worker = {
    async runOnce({ limit = 20 } = {}) {
      const processing = await escrowService.processOutboxBatch({ limit });
      const reconciliation = await escrowService.reconcilePendingOperations({ limit });
      return { processing, reconciliation };
    },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 5000, limit = 20, onStatusChange: observeStatus, metrics: observeMetrics, collectOutboxMetrics: collectMetrics } = {}) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new RangeError("Invalid escrow worker interval");
      if (timer) return worker.stop;
      onStatusChange = typeof observeStatus === "function" ? observeStatus : () => {};
      metrics = observeMetrics; collectOutboxMetrics = collectMetrics;
      stopping = false; setState("running");
      const tick = () => {
        if (stopping || activeRun) return;
        const startedAt = Date.now();
        activeRun = worker.runOnce({ limit }).then((result) => { recordWorkerRunMetrics(metrics, "escrow", "success", Date.now() - startedAt); recordOutboxBatchMetrics(metrics, "escrow", result); status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) setState("running"); }).catch(() => { recordWorkerRunMetrics(metrics, "escrow", "failure", Date.now() - startedAt); status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) setState("degraded"); }).finally(() => { activeRun = null; void Promise.resolve().then(() => collectOutboxMetrics?.collect()).catch(() => {}); });
      };
      tick();
      timer = setIntervalFn(tick, intervalMs);
      timer.unref?.();
      return worker.stop;
    },
    async stop() {
      stopping = true; setState("stopping");
      if (timer) clearIntervalFn(timer);
      timer = null;
      if (activeRun) await activeRun;
      setState("stopped");
    },
  };
  return Object.freeze(worker);
};
