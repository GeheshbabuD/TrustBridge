import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startServer } from "../../src/server.js";
import { createApp } from "../../src/app.js";
import { getEnv } from "../../src/config/env.js";
import { createNotificationOutboxWorker } from "../../src/workers/notification-outbox.worker.js";
import { createOperationalAlertAdapter } from "../../src/services/operational-alert.adapter.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://synthetic:synthetic@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "lifecycle-test-access-secret-with-enough-entropy-123";
process.env.JWT_REFRESH_SECRET = "lifecycle-test-refresh-secret-with-enough-entropy-456";

const bareApp = (locals = {}) => Object.assign((_request, response) => response.end("ok"), { locals });

test("listener stops accepting connections before worker drain and resources close afterward", async () => {
  const events = [];
  let finishWorker;
  const app = bareApp({ notificationWorker: { start() { events.push("worker-start"); return () => { events.push("worker-stop"); return new Promise((resolve) => { finishWorker = resolve; }); }; } } });
  const { server, shutdown } = startServer(0, { appInstance: app, disconnectDatabase: async () => events.push("db-close"), closeRateLimitStore: async () => events.push("redis-close") });
  await once(server, "listening");
  const port = server.address().port;
  const closing = shutdown();
  assert.equal(server.listening, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["worker-start", "worker-stop"]);
  assert.deepEqual(await fetch(`http://127.0.0.1:${port}`).then((response) => response.status).catch(() => 0), 0);
  finishWorker();
  await closing;
  assert.deepEqual(events, ["worker-start", "worker-stop", "db-close", "redis-close"]);
});

test("HTTP shutdown drains active requests before closing shared resources", async () => {
  let finishRequest;
  const app = Object.assign((_request, response) => { finishRequest = () => response.end("done"); }, { locals: {} });
  const closed = [];
  const { server, shutdown } = startServer(0, { appInstance: app, disconnectDatabase: async () => closed.push("db"), closeRateLimitStore: async () => closed.push("redis") });
  await once(server, "listening");
  const requestDone = fetch(`http://127.0.0.1:${server.address().port}`, { headers: { connection: "close" } }).then((response) => response.text());
  while (!finishRequest) await new Promise((resolve) => setImmediate(resolve));
  const closing = shutdown();
  assert.equal(server.listening, false);
  assert.deepEqual(closed, []);
  finishRequest();
  assert.equal(await requestDone, "done");
  await closing;
  assert.deepEqual(closed, ["db", "redis"]);
});

test("drain timeout is visible and leaves dependencies open when a worker has not confirmed completion", async () => {
  let finishWorker;
  let disconnects = 0;
  const app = bareApp({ escrowWorker: { start() { return () => new Promise((resolve) => { finishWorker = resolve; }); }, getStatus: () => ({ state: "stopping" }) } });
  const { server, shutdown, lifecycleStatus } = startServer(0, { appInstance: app, drainTimeoutMs: 1000, disconnectDatabase: async () => { disconnects += 1; }, closeRateLimitStore: async () => { disconnects += 1; } });
  await once(server, "listening");
  await assert.rejects(shutdown(), /timed out/);
  assert.equal(lifecycleStatus.state, "drain_timeout");
  assert.equal(lifecycleStatus.workers.escrow.state, "drain_timeout");
  assert.equal(disconnects, 0);
  finishWorker();
});

test("worker startup failure is exposed as sanitized readiness status, not made a readiness gate", async () => {
  const app = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => true });
  app.locals.notificationWorker = { start() { throw new Error("private endpoint and credential"); }, getStatus: () => ({ state: "stopped" }) };
  const { server, shutdown } = startServer(0, { appInstance: app });
  await once(server, "listening");
  try {
    const payload = await fetch(`http://127.0.0.1:${server.address().port}/health/ready`).then((response) => response.json());
    assert.equal(payload.data.status, "ready");
    assert.equal(payload.data.workers.notification.state, "failed");
    assert.equal(payload.data.workers.notification.lastErrorCode, "WORKER_START_FAILED");
    assert.doesNotMatch(JSON.stringify(payload), /private endpoint|credential/i);
  } finally { await shutdown(); }
});

test("required escrow worker startup failure makes readiness unhealthy while liveness stays healthy", async () => {
  const alerts = [];
  const app = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => true });
  app.locals.notificationWorker = null;
  app.locals.escrowWorker = { start() { throw new Error("private provider URL and secret"); }, getStatus: () => ({ state: "stopped" }) };
  const { server, shutdown } = startServer(0, { appInstance: app, operationalAlertAdapter: { notify: async (alert) => alerts.push(alert) } });
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ready = await fetch(`${base}/health/ready`);
    const payload = await ready.json();
    assert.equal(ready.status, 503);
    assert.equal(payload.data.status, "not_ready");
    assert.equal(payload.data.workers.escrow.required, true);
    assert.equal(payload.data.workers.escrow.state, "failed");
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(alerts.map(({ type, worker, required }) => ({ type, worker, required })), [{ type: "WORKER_UNAVAILABLE", worker: "escrow", required: true }]);
    assert.equal(app.locals.operationalMetrics.snapshot().some((metric) => metric.name === "worker_state" && metric.labels.worker === "escrow" && metric.labels.state === "failed" && metric.value === 1), true);
    assert.doesNotMatch(JSON.stringify({ ...payload, alerts }), /private provider URL|secret/);
  } finally { await shutdown(); }
});

test("runtime worker degradation and recovery update readiness and emit sanitized transitions", async () => {
  const alerts = []; let status; let report;
  const app = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => true });
  app.locals.notificationWorker = null;
  app.locals.escrowWorker = {
    start({ onStatusChange }) { report = onStatusChange; status = { state: "running", consecutiveFailures: 0 }; report(status); return async () => {}; },
    getStatus() { return status; },
  };
  const { server, shutdown } = startServer(0, { appInstance: app, operationalAlertAdapter: { notify: async (alert) => alerts.push(alert) } });
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    status = { state: "degraded", consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastErrorCode: "WORKER_RUN_FAILED" };
    report(status);
    const degraded = await fetch(`${base}/health/ready`);
    const degradedPayload = await degraded.json();
    assert.equal(degraded.status, 503);
    assert.equal(degradedPayload.data.workers.escrow.state, "degraded");
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    status = { state: "running", consecutiveFailures: 0, lastSuccessAt: new Date().toISOString() };
    report(status);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(alerts.map((alert) => alert.type), ["WORKER_UNAVAILABLE", "WORKER_RECOVERED"]);
    assert.equal(alerts.every((alert) => alert.worker === "escrow" && alert.required === true), true);
    assert.doesNotMatch(JSON.stringify(alerts), /transactionId|payment|stack|secret|credential/i);
  } finally { await shutdown(); }
});

test("operational alert delivery failure is sanitized and does not throw", async () => {
  const logs = [];
  const adapter = createOperationalAlertAdapter({ send: async () => { throw new Error("private alert endpoint credential"); }, writeLog: (record) => logs.push(record) });
  assert.equal(await adapter.notify({ type: "WORKER_UNAVAILABLE", worker: "escrow", state: "degraded", required: true, lastErrorCode: "WORKER_RUN_FAILED", details: "sensitive transaction data" }), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "operational_alert_delivery_failed");
  assert.equal(logs[0].errorCode, "ALERT_DELIVERY_FAILED");
  assert.doesNotMatch(JSON.stringify(logs), /private alert endpoint|credential|sensitive transaction data/);
});

test("repeated shutdown calls share one bounded shutdown operation", async () => {
  let stops = 0;
  const app = bareApp({ blockchainWorker: { start() { return async () => { stops += 1; }; } } });
  const { server, shutdown } = startServer(0, { appInstance: app });
  await once(server, "listening");
  const first = shutdown();
  assert.strictEqual(first, shutdown());
  await first;
  assert.equal(stops, 1);
});

test("server injects internal metrics adapters into supervised workers", async () => {
  let received;
  const metrics = { increment() {}, gauge() {}, observe() {}, snapshot() { return []; } };
  const collector = { async collect() { return true; } };
  const app = bareApp({ operationalMetrics: metrics, collectOutboxMetrics: collector, notificationWorker: { start(options) { received = options; return async () => {}; } } });
  const { server, shutdown } = startServer(0, { appInstance: app });
  await once(server, "listening");
  assert.strictEqual(received.metrics, metrics);
  assert.strictEqual(received.collectOutboxMetrics, collector);
  await shutdown();
});

test("worker runtime failures and recovery expose only sanitized status", async () => {
  let calls = 0; const statusChanges = [];
  let tick;
  const worker = createNotificationOutboxWorker({
    notificationService: { async processOutboxBatch() { calls += 1; if (calls === 1) throw new Error("private provider response"); return { processed: 1 }; } },
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  worker.start({ onStatusChange: (status) => statusChanges.push(status.state) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.getStatus().state, "degraded");
  assert.equal(worker.getStatus().lastErrorCode, "WORKER_RUN_FAILED");
  assert.equal(JSON.stringify(worker.getStatus()).includes("private provider response"), false);
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.getStatus().state, "running");
  assert.equal(worker.getStatus().consecutiveFailures, 0);
  assert.deepEqual(statusChanges, ["running", "degraded", "running"]);
  await worker.stop();
});
