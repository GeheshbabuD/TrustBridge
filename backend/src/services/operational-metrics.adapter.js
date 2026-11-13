const workers = new Set(["notification", "escrow", "blockchain"]);
const workerStates = new Set(["starting", "running", "degraded", "stopping", "stopped", "failed", "drain_timeout", "disabled", "unknown"]);
const workerOutcomes = new Set(["success", "failure"]);
const batchOutcomes = new Set(["claimed", "succeeded", "deferred", "failed"]);
const outboxStatuses = new Set(["PENDING", "PROCESSING", "PUBLISHED", "FAILED"]);
const definitions = Object.freeze({
  worker_state: { kind: "gauge", labels: { worker: workers, state: workerStates } },
  worker_transitions_total: { kind: "counter", labels: { worker: workers, from: workerStates, to: workerStates } },
  worker_runs_total: { kind: "counter", labels: { worker: workers, outcome: workerOutcomes } },
  worker_processing_duration_ms: { kind: "duration", labels: { worker: workers, outcome: workerOutcomes } },
  outbox_batch_events_total: { kind: "counter", labels: { worker: workers, outcome: batchOutcomes } },
  outbox_events: { kind: "gauge", labels: { worker: workers, status: outboxStatuses } },
  outbox_retries: { kind: "gauge", labels: { worker: workers, status: outboxStatuses } },
  outbox_expired_leases: { kind: "gauge", labels: { worker: workers } },
  outbox_oldest_pending_age_seconds: { kind: "gauge", labels: { worker: workers } },
  metrics_collection_failures_total: { kind: "counter", labels: { source: new Set(["outbox"]) } },
});

const normalizedLabels = (definition, labels) => {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return null;
  const keys = Object.keys(definition.labels);
  if (Object.keys(labels).length !== keys.length || keys.some((key) => !definition.labels[key].has(labels[key]))) return null;
  return Object.fromEntries(keys.sort().map((key) => [key, labels[key]]));
};

/** Bounded, provider-neutral metric registry. Only enumerated names and labels are accepted. */
export const createOperationalMetricsAdapter = ({ sink } = {}) => {
  if (sink !== undefined && typeof sink !== "function") throw new TypeError("Metrics sink must be a function");
  const values = new Map();
  const write = (name, value, labels, method) => {
    const definition = definitions[name];
    const safeLabels = definition && normalizedLabels(definition, labels);
    if (!definition || !safeLabels || definition.kind !== method || !Number.isFinite(value) || value < 0) return false;
    const key = `${name}:${JSON.stringify(safeLabels)}`;
    const current = values.get(key);
    let next;
    if (method === "counter") next = (current?.value ?? 0) + value;
    else if (method === "duration") next = { count: (current?.value?.count ?? 0) + 1, total: (current?.value?.total ?? 0) + value, max: Math.max(current?.value?.max ?? 0, value) };
    else next = value;
    if (typeof next === "number" && !Number.isFinite(next)) return false;
    values.set(key, { name, labels: safeLabels, kind: method, value: next });
    if (sink) {
      const sample = Object.freeze({ name, labels: Object.freeze({ ...safeLabels }), kind: method, value: method === "duration" ? value : next });
      void Promise.resolve().then(() => sink(sample)).catch(() => {});
    }
    return true;
  };
  return Object.freeze({
    increment(name, value = 1, labels) { return write(name, value, labels, "counter"); },
    gauge(name, value, labels) { return write(name, value, labels, "gauge"); },
    observe(name, value, labels) { return write(name, value, labels, "duration"); },
    snapshot() {
      return Object.freeze([...values.values()].map((entry) => Object.freeze({ name: entry.name, labels: Object.freeze({ ...entry.labels }), kind: entry.kind, value: typeof entry.value === "object" ? Object.freeze({ ...entry.value }) : entry.value })));
    },
  });
};

const safely = (metrics, method, ...args) => {
  try {
    const result = metrics?.[method]?.(...args);
    void Promise.resolve(result).catch(() => {});
  } catch { /* Metrics never control application work. */ }
};
export const recordWorkerStateMetrics = (metrics, worker, previous, current) => {
  if (!metrics) return;
  safely(metrics, "gauge", "worker_state", 0, { worker, state: previous });
  safely(metrics, "gauge", "worker_state", 1, { worker, state: current });
  safely(metrics, "increment", "worker_transitions_total", 1, { worker, from: previous, to: current });
};
export const recordWorkerRunMetrics = (metrics, worker, outcome, durationMs) => {
  if (!metrics) return;
  safely(metrics, "increment", "worker_runs_total", 1, { worker, outcome });
  safely(metrics, "observe", "worker_processing_duration_ms", durationMs, { worker, outcome });
};
export const recordOutboxBatchMetrics = (metrics, worker, batch) => {
  if (!metrics || !batch) return;
  const summary = worker === "escrow" ? batch.processing : batch;
  if (!summary || typeof summary !== "object") return;
  for (const [field, outcome] of [["claimed", "claimed"], ["published", "succeeded"], ["processed", "succeeded"], ["deferred", "deferred"], ["failed", "failed"]]) {
    if (Number.isSafeInteger(summary[field]) && summary[field] > 0) safely(metrics, "increment", "outbox_batch_events_total", summary[field], { worker, outcome });
  }
};

const eventTypesByWorker = Object.freeze({
  notification: ["USER_NOTIFICATION"],
  escrow: ["ESCROW_RELEASE_AUTHORIZED", "ESCROW_REFUND_AUTHORIZED"],
  blockchain: ["BLOCKCHAIN_ANCHOR"],
});
const workerByEventType = Object.freeze(Object.fromEntries(Object.entries(eventTypesByWorker).flatMap(([worker, eventTypes]) => eventTypes.map((eventType) => [eventType, worker]))));

/** Collects aggregate outbox health only; record identifiers and payloads are never selected. */
export const createOutboxMetricsCollector = ({ getClient, metrics, now = () => new Date(), intervalMs = 60_000 } = {}) => {
  if (typeof getClient !== "function" || !metrics || typeof metrics.gauge !== "function" || typeof metrics.increment !== "function") throw new TypeError("Outbox metrics require a database client and metrics adapter");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new RangeError("Invalid outbox metrics interval");
  let lastCollectedAt = Number.NEGATIVE_INFINITY;
  let inFlight;
  return Object.freeze({
    async collect({ force = false } = {}) {
      const stamp = now();
      if (inFlight) return inFlight;
      if (!force && stamp.getTime() - lastCollectedAt < intervalMs) return false;
      lastCollectedAt = stamp.getTime();
      inFlight = Promise.resolve().then(async () => {
        try {
          const prisma = await getClient();
          const eventTypes = Object.keys(workerByEventType);
          const [statusGroups, pendingGroups, expiredGroups] = await Promise.all([
            prisma.outboxEvent.groupBy({ by: ["eventType", "status"], where: { eventType: { in: eventTypes } }, _count: { _all: true }, _sum: { attemptCount: true } }),
            prisma.outboxEvent.groupBy({ by: ["eventType"], where: { eventType: { in: eventTypes }, status: "PENDING" }, _min: { createdAt: true } }),
            prisma.outboxEvent.groupBy({ by: ["eventType"], where: { eventType: { in: eventTypes }, status: "PROCESSING", leaseExpiresAt: { lte: stamp } }, _count: { _all: true } }),
          ]);
          for (const [worker, types] of Object.entries(eventTypesByWorker)) {
            const statusTotals = new Map();
            for (const type of types) {
              for (const status of outboxStatuses) statusTotals.set(status, (statusTotals.get(status) ?? 0));
            }
            for (const group of statusGroups) {
              if (!types.includes(group.eventType) || !outboxStatuses.has(group.status)) continue;
              statusTotals.set(group.status, (statusTotals.get(group.status) ?? 0) + (group._count?._all ?? 0));
              const count = group._count?._all ?? 0;
              const attempts = group._sum?.attemptCount ?? 0;
              safely(metrics, "gauge", "outbox_retries", Math.max(0, attempts - count), { worker, status: group.status });
            }
            for (const [status, count] of statusTotals) safely(metrics, "gauge", "outbox_events", count, { worker, status });
            const pending = pendingGroups.filter((group) => types.includes(group.eventType)).map((group) => group._min?.createdAt).filter((date) => date instanceof Date);
            const oldest = pending.length ? Math.min(...pending.map((date) => date.getTime())) : null;
            safely(metrics, "gauge", "outbox_oldest_pending_age_seconds", oldest === null ? 0 : Math.max(0, (stamp.getTime() - oldest) / 1000), { worker });
            const expired = expiredGroups.filter((group) => types.includes(group.eventType)).reduce((total, group) => total + (group._count?._all ?? 0), 0);
            safely(metrics, "gauge", "outbox_expired_leases", expired, { worker });
          }
          return true;
        } catch {
          safely(metrics, "increment", "metrics_collection_failures_total", 1, { source: "outbox" });
          return false;
        } finally { inFlight = undefined; }
      });
      return inFlight;
    },
  });
};
