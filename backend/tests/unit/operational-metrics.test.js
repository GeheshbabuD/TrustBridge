import test from "node:test";
import assert from "node:assert/strict";
import { createOperationalMetricsAdapter, createOutboxMetricsCollector } from "../../src/services/operational-metrics.adapter.js";

test("operational metrics enforce bounded labels and maintain accurate counters, gauges and durations", () => {
  const metrics = createOperationalMetricsAdapter();
  assert.equal(metrics.increment("worker_runs_total", 2, { worker: "escrow", outcome: "success" }), true);
  assert.equal(metrics.gauge("worker_state", 1, { worker: "escrow", state: "running" }), true);
  assert.equal(metrics.observe("worker_processing_duration_ms", 12, { worker: "escrow", outcome: "success" }), true);
  assert.equal(metrics.observe("worker_processing_duration_ms", 18, { worker: "escrow", outcome: "success" }), true);
  assert.equal(metrics.increment("worker_runs_total", 1, { worker: "escrow", outcome: "success", transactionId: "private" }), false);
  assert.equal(metrics.increment("unknown_metric", 1, {}), false);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot.find((entry) => entry.name === "worker_runs_total").value, 2);
  assert.deepEqual(snapshot.find((entry) => entry.name === "worker_processing_duration_ms").value, { count: 2, total: 30, max: 18 });
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
});

test("metrics sink failures are isolated from metric collection", async () => {
  const metrics = createOperationalMetricsAdapter({ sink: () => { throw new Error("sensitive exporter detail"); } });
  assert.equal(metrics.increment("worker_runs_total", 1, { worker: "notification", outcome: "failure" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(metrics.snapshot()[0].value, 1);
});

test("outbox collector records bounded queue, retry, lease-expiry and oldest-pending gauges only", async () => {
  const metrics = createOperationalMetricsAdapter();
  const stamp = new Date("2026-11-13T12:00:00.000Z");
  const calls = [];
  const prisma = { outboxEvent: { groupBy: async (args) => {
    calls.push(args);
    if (args.by.includes("status")) return [
      { eventType: "ESCROW_REFUND_AUTHORIZED", status: "PENDING", _count: { _all: 2 }, _sum: { attemptCount: 5 } },
      { eventType: "ESCROW_REFUND_AUTHORIZED", status: "PROCESSING", _count: { _all: 1 }, _sum: { attemptCount: 1 } },
      { eventType: "USER_NOTIFICATION", status: "FAILED", _count: { _all: 3 }, _sum: { attemptCount: 24 } },
    ];
    if (args.where.status === "PENDING") return [
      { eventType: "ESCROW_REFUND_AUTHORIZED", _min: { createdAt: new Date(stamp.getTime() - 90_000) } },
    ];
    return [{ eventType: "ESCROW_REFUND_AUTHORIZED", _count: { _all: 1 } }];
  } } };
  const collector = createOutboxMetricsCollector({ getClient: async () => prisma, metrics, now: () => stamp, intervalMs: 60_000 });
  assert.equal(await collector.collect(), true);
  assert.equal(await collector.collect(), false);
  assert.equal(calls.length, 3);
  assert.equal(calls.every(({ select }) => select === undefined), true);
  const snapshot = metrics.snapshot();
  const read = (name, labels) => snapshot.find((entry) => entry.name === name && Object.entries(labels).every(([key, value]) => entry.labels[key] === value))?.value;
  assert.equal(read("outbox_events", { worker: "escrow", status: "PENDING" }), 2);
  assert.equal(read("outbox_retries", { worker: "escrow", status: "PENDING" }), 3);
  assert.equal(read("outbox_expired_leases", { worker: "escrow" }), 1);
  assert.equal(read("outbox_oldest_pending_age_seconds", { worker: "escrow" }), 90);
  assert.equal(read("outbox_events", { worker: "notification", status: "FAILED" }), 3);
  assert.equal(JSON.stringify(snapshot).includes("transactionId"), false);
});

test("outbox metric collection failures increment a safe counter and return without throwing", async () => {
  const metrics = createOperationalMetricsAdapter();
  const collector = createOutboxMetricsCollector({ getClient: async () => { throw new Error("database URL details"); }, metrics, intervalMs: 0 });
  assert.equal(await collector.collect(), false);
  const failure = metrics.snapshot().find((entry) => entry.name === "metrics_collection_failures_total");
  assert.equal(failure.value, 1);
  assert.equal(JSON.stringify(metrics.snapshot()).includes("database URL details"), false);
});
