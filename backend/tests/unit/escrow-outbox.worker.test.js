import test from "node:test";
import assert from "node:assert/strict";
import { createEscrowOutboxWorker } from "../../src/workers/escrow-outbox.worker.js";
import { createOperationalMetricsAdapter } from "../../src/services/operational-metrics.adapter.js";

test("supervised escrow worker runs durable outbox processing and pending-provider reconciliation", async () => {
  const calls = [];
  const worker = createEscrowOutboxWorker({ escrowService: {
    processOutboxBatch: async (options) => { calls.push(["outbox", options]); return { claimed: 1, processed: 1, deferred: 0 }; },
    reconcilePendingOperations: async (options) => { calls.push(["reconcile", options]); return { checked: 1, results: [{ status: "SUCCEEDED" }] }; },
  } });
  assert.deepEqual(await worker.runOnce({ limit: 5 }), {
    processing: { claimed: 1, processed: 1, deferred: 0 }, reconciliation: { checked: 1, results: [{ status: "SUCCEEDED" }] },
  });
  assert.deepEqual(calls, [["outbox", { limit: 5 }], ["reconcile", { limit: 5 }]]);
});

test("worker start serializes ticks and graceful stop waits for an in-flight batch", async () => {
  let tick; let active = 0; let maximumActive = 0; let finish;
  const inFlight = new Promise((resolve) => { finish = resolve; });
  const worker = createEscrowOutboxWorker({
    setIntervalFn(callback) { tick = callback; return { unref() {} }; },
    clearIntervalFn() {},
    escrowService: {
      async processOutboxBatch() { active += 1; maximumActive = Math.max(maximumActive, active); await inFlight; active -= 1; return {}; },
      async reconcilePendingOperations() { return {}; },
    },
  });
  const stop = worker.start();
  tick();
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(maximumActive, 1);
  assert.equal(stopped, false);
  finish(); await stopping;
  assert.equal(stopped, true);
});

test("worker metrics count lifecycle transitions, run outcomes and batch events without affecting work", async () => {
  const metrics = createOperationalMetricsAdapter(); let tick; let calls = 0;
  const worker = createEscrowOutboxWorker({
    setIntervalFn(callback) { tick = callback; return { unref() {} }; },
    clearIntervalFn() {},
    escrowService: {
      async processOutboxBatch() { calls += 1; if (calls === 1) throw new Error("private financial detail"); return { claimed: 2, processed: 1, deferred: 0, failed: 1 }; },
      async reconcilePendingOperations() { return { checked: 0, results: [] }; },
    },
  });
  worker.start({ metrics, collectOutboxMetrics: { async collect() { throw new Error("metric storage unavailable"); } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.getStatus().state, "degraded");
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.getStatus().state, "running");
  await worker.stop();
  const snapshot = metrics.snapshot();
  const read = (name, labels) => snapshot.find((entry) => entry.name === name && Object.entries(labels).every(([key, value]) => entry.labels[key] === value))?.value;
  assert.equal(read("worker_runs_total", { worker: "escrow", outcome: "failure" }), 1);
  assert.equal(read("worker_runs_total", { worker: "escrow", outcome: "success" }), 1);
  assert.equal(read("outbox_batch_events_total", { worker: "escrow", outcome: "claimed" }), 2);
  assert.equal(read("outbox_batch_events_total", { worker: "escrow", outcome: "failed" }), 1);
  assert.equal(read("worker_state", { worker: "escrow", state: "stopped" }), 1);
  assert.equal(read("worker_transitions_total", { worker: "escrow", from: "degraded", to: "running" }), 1);
  assert.ok(read("worker_processing_duration_ms", { worker: "escrow", outcome: "success" }).count === 1);
  assert.equal(JSON.stringify(snapshot).includes("private financial detail"), false);
});
