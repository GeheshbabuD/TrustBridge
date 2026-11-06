/** One bounded worker tick; invoke from the deployment's supervised scheduler. */
export const createEscrowOutboxWorker = ({ escrowService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!escrowService || typeof escrowService.processOutboxBatch !== "function" || typeof escrowService.reconcilePendingOperations !== "function") {
    throw new TypeError("Escrow worker requires the escrow execution service");
  }
  let timer = null;
  let activeRun = null;
  let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  const worker = {
    async runOnce({ limit = 20 } = {}) {
      const processing = await escrowService.processOutboxBatch({ limit });
      const reconciliation = await escrowService.reconcilePendingOperations({ limit });
      return { processing, reconciliation };
    },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 5000, limit = 20 } = {}) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new RangeError("Invalid escrow worker interval");
      if (timer) return worker.stop;
      stopping = false; status.state = "running";
      const tick = () => {
        if (stopping || activeRun) return;
        activeRun = worker.runOnce({ limit }).then(() => { status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) status.state = "running"; }).catch(() => { status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) status.state = "degraded"; }).finally(() => { activeRun = null; });
      };
      tick();
      timer = setIntervalFn(tick, intervalMs);
      timer.unref?.();
      return worker.stop;
    },
    async stop() {
      stopping = true; status.state = "stopping";
      if (timer) clearIntervalFn(timer);
      timer = null;
      if (activeRun) await activeRun;
      status.state = "stopped";
    },
  };
  return Object.freeze(worker);
};
