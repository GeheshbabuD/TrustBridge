import test from "node:test";
import assert from "node:assert/strict";
import { createEscrowOutboxWorker } from "../../src/workers/escrow-outbox.worker.js";

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
