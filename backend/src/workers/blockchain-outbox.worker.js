/** Supervised bounded blockchain commitment and reconciliation worker. */
export const createBlockchainOutboxWorker = ({ blockchainService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!blockchainService || typeof blockchainService.processOutboxBatch !== "function" || typeof blockchainService.reconcilePending !== "function") throw new TypeError("Blockchain worker requires blockchain service");
  let timer = null; let active = null; let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  const worker = {
    async runOnce({ limit = 20 } = {}) { const processing = await blockchainService.processOutboxBatch({ limit }); const reconciliation = await blockchainService.reconcilePending({ limit }); return { processing, reconciliation }; },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 15_000, limit = 20 } = {}) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 300_000) throw new RangeError("Invalid blockchain worker interval");
      if (timer) return worker.stop;
      stopping = false; status.state = "running";
      const tick = () => { if (stopping || active) return; active = worker.runOnce({ limit }).then(() => { status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) status.state = "running"; }).catch(() => { status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) status.state = "degraded"; }).finally(() => { active = null; }); };
      tick(); timer = setIntervalFn(tick, intervalMs); timer.unref?.(); return worker.stop;
    },
    async stop() { stopping = true; status.state = "stopping"; if (timer) clearIntervalFn(timer); timer = null; if (active) await active; status.state = "stopped"; },
  };
  return Object.freeze(worker);
};
