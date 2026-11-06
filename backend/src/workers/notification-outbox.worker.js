/** Supervised timer around the shared-database leased notification outbox. */
export const createNotificationOutboxWorker = ({ notificationService, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) => {
  if (!notificationService || typeof notificationService.processOutboxBatch !== "function") throw new TypeError("Notification worker requires notification service");
  let timer = null; let active = null; let stopping = false;
  const status = { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null };
  const worker = {
    async runOnce({ limit = 20 } = {}) { return notificationService.processOutboxBatch({ limit }); },
    getStatus() { return Object.freeze({ ...status }); },
    start({ intervalMs = 3000, limit = 20 } = {}) {
      if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 300_000) throw new RangeError("Invalid notification worker interval");
      if (timer) return worker.stop;
      stopping = false; status.state = "running";
      const tick = () => { if (stopping || active) return; active = worker.runOnce({ limit }).then(() => { status.consecutiveFailures = 0; status.lastSuccessAt = new Date().toISOString(); status.lastErrorCode = null; if (!stopping) status.state = "running"; }).catch(() => { status.consecutiveFailures += 1; status.lastFailureAt = new Date().toISOString(); status.lastErrorCode = "WORKER_RUN_FAILED"; if (!stopping) status.state = "degraded"; }).finally(() => { active = null; }); };
      tick(); timer = setIntervalFn(tick, intervalMs); timer.unref?.(); return worker.stop;
    },
    async stop() { stopping = true; status.state = "stopping"; if (timer) clearIntervalFn(timer); timer = null; if (active) await active; status.state = "stopped"; },
  };
  return Object.freeze(worker);
};
