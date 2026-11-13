import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { loadApplicationDependencies } from "./config/application-composition.js";
import { disconnectDatabase } from "./config/db.js";
import { closeRateLimitStore } from "./services/rate-limit-store.service.js";
import { createOperationalAlertAdapter } from "./services/operational-alert.adapter.js";
import { recordWorkerStateMetrics } from "./services/operational-metrics.adapter.js";
import { writeStructuredLog } from "./utils/logger.js";

const sanitizedWorkerState = (state) => ({
  state: ["starting", "running", "degraded", "stopping", "stopped", "failed", "drain_timeout", "disabled", "unknown"].includes(state?.state) ? state.state : "unknown",
  required: state?.required === true,
  consecutiveFailures: Number.isSafeInteger(state?.consecutiveFailures) && state.consecutiveFailures >= 0 ? state.consecutiveFailures : 0,
  lastSuccessAt: typeof state?.lastSuccessAt === "string" ? state.lastSuccessAt : null,
  lastFailureAt: typeof state?.lastFailureAt === "string" ? state.lastFailureAt : null,
  lastErrorCode: ["WORKER_RUN_FAILED", "WORKER_START_FAILED", "WORKER_STOP_FAILED", "DRAIN_TIMEOUT"].includes(state?.lastErrorCode) ? state.lastErrorCode : null,
});

export const startServer = (port = getEnv().port, options = {}) => {
  const disconnectDatabaseResource = options.disconnectDatabase ?? disconnectDatabase;
  const closeRateLimitResource = options.closeRateLimitStore ?? closeRateLimitStore;
  const appInstance = options.appInstance ?? createApp(getEnv());
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  const workerIntervalMs = options.escrowWorkerIntervalMs ?? 5000;
  const onStatus = options.onStatus ?? (() => {});
  const operationalAlertAdapter = options.operationalAlertAdapter ?? appInstance.locals?.operationalAlertAdapter ?? createOperationalAlertAdapter();
  if (!operationalAlertAdapter || typeof operationalAlertAdapter.notify !== "function") throw new TypeError("Operational alert adapter must implement notify");
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1000 || drainTimeoutMs > 300_000) throw new RangeError("Invalid graceful drain timeout");
  const server = createServer(appInstance);
  const workerStops = [];
  const workers = {};
  let shutdownPromise;
  let stopping = false;
  const lifecycleStatus = { state: "starting", workers };
  appInstance.locals ??= {};
  appInstance.locals.lifecycleStatus = lifecycleStatus;
  const publishStatus = () => {
    try {
      onStatus(Object.freeze({
        state: lifecycleStatus.state,
        workers: Object.fromEntries(Object.entries(workers).map(([name, status]) => [name, sanitizedWorkerState(status)])),
      }));
    } catch { /* observers must not disrupt the service */ }
  };

  const workerEntries = () => [
    ["notification", appInstance.locals?.notificationWorker, false],
    ["escrow", appInstance.locals?.escrowWorker, Boolean(appInstance.locals?.escrowWorker)],
    ["blockchain", appInstance.locals?.blockchainWorker, false],
  ];
  const notifyWorkerTransition = (name, required, previousState, state) => {
    if (lifecycleStatus.state !== "running" || state === "stopping" || previousState === state) return;
    const unavailable = state !== "running" && state !== "disabled";
    const recovered = state === "running" && ["degraded", "failed", "stopped", "drain_timeout", "unknown"].includes(previousState);
    if (!unavailable && !recovered) return;
    const alert = sanitizedWorkerState({ ...workers[name], state, required });
    void Promise.resolve().then(() => operationalAlertAdapter.notify({
      type: unavailable ? "WORKER_UNAVAILABLE" : "WORKER_RECOVERED",
      worker: name,
      ...alert,
      timestamp: new Date().toISOString(),
    })).catch(() => {
      try { writeStructuredLog({ timestamp: new Date().toISOString(), level: "error", event: "operational_alert_delivery_failed", worker: name, type: unavailable ? "WORKER_UNAVAILABLE" : "WORKER_RECOVERED", required, errorCode: "ALERT_DELIVERY_FAILED" }); }
      catch { /* Alerting and fallback logging cannot affect service work. */ }
    });
  };
  const updateWorkerStatus = (name, required, rawStatus) => {
    const previousState = workers[name]?.state ?? "starting";
    const safe = sanitizedWorkerState(rawStatus);
    workers[name] = { ...safe, required };
    appInstance.locals.lifecycleStatus = lifecycleStatus;
    publishStatus();
    notifyWorkerTransition(name, required, previousState, safe.state);
  };
  const stopWorkers = async () => {
    const stops = workerEntries().map(([name, worker, required]) => {
      if (!worker || workers[name]?.state === "disabled") return Promise.resolve();
      workers[name] = { ...sanitizedWorkerState({ ...(worker.getStatus?.() ?? {}), state: "stopping" }), required };
      const stop = workerStops.find((entry) => entry.name === name)?.stop ?? worker.stop?.bind(worker);
      if (typeof stop !== "function") {
        workers[name] = { ...sanitizedWorkerState({ ...(worker.getStatus?.() ?? {}), state: "stopped" }), required };
        return Promise.resolve();
      }
      return Promise.resolve().then(stop).then(() => {
        workers[name] = { ...sanitizedWorkerState({ ...(worker.getStatus?.() ?? {}), state: "stopped" }), required };
      }).catch(() => {
        recordWorkerStateMetrics(appInstance.locals?.operationalMetrics, name, "stopping", "degraded");
        workers[name] = { ...sanitizedWorkerState({ ...(worker.getStatus?.() ?? {}), state: "degraded", lastErrorCode: "WORKER_STOP_FAILED" }), required };
        throw new Error("Worker shutdown did not complete");
      }).finally(publishStatus);
    });
    await Promise.all(stops);
  };

  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true;
      lifecycleStatus.state = "draining";
      publishStatus();

      // server.close stops accepting new connections before workers are asked to stop.
      const httpClosed = new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
      const stopPromise = stopWorkers();
      let timeout;
      const timeoutError = new Error("Graceful drain timed out");
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError), drainTimeoutMs);
      });
      try {
        await Promise.race([Promise.all([httpClosed, stopPromise]), deadline]);
      } catch (error) {
        if (error === timeoutError) {
          lifecycleStatus.state = "drain_timeout";
          for (const [name, worker, required] of workerEntries()) {
            if (workers[name]?.state === "stopping") {
              recordWorkerStateMetrics(appInstance.locals?.operationalMetrics, name, "stopping", "drain_timeout");
              workers[name] = { ...sanitizedWorkerState({ ...(worker?.getStatus?.() ?? {}), state: "drain_timeout", lastErrorCode: "DRAIN_TIMEOUT" }), required };
            }
          }
          server.closeAllConnections?.();
          publishStatus();
          // Do not close DB/Redis under an unconfirmed in-flight worker operation.
          throw error;
        }
        lifecycleStatus.state = "shutdown_failed";
        publishStatus();
        throw new Error("Graceful shutdown failed");
      } finally {
        clearTimeout(timeout);
      }

      try {
        await disconnectDatabaseResource();
        await closeRateLimitResource();
      } catch {
        lifecycleStatus.state = "shutdown_failed";
        publishStatus();
        throw new Error("Graceful shutdown resource close failed");
      }
      lifecycleStatus.state = "stopped";
      publishStatus();
    })();
    return shutdownPromise;
  };

  server.once("listening", () => {
    if (stopping) return;
    lifecycleStatus.state = "running";
    for (const [name, worker, required] of workerEntries()) {
      if (!worker) {
        workers[name] = { ...sanitizedWorkerState({ state: "disabled" }), required: false };
        continue;
      }
      if (typeof worker.start !== "function") {
        const previousState = "starting";
        if (!required) { workers[name] = { ...sanitizedWorkerState({ state: "disabled" }), required: false }; continue; }
        recordWorkerStateMetrics(appInstance.locals?.operationalMetrics, name, previousState, "failed");
        workers[name] = { ...sanitizedWorkerState({ state: "failed", consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastErrorCode: "WORKER_START_FAILED" }), required };
        notifyWorkerTransition(name, required, previousState, "failed");
        continue;
      }
      try {
        const stop = worker.start({ intervalMs: workerIntervalMs, metrics: appInstance.locals.operationalMetrics, collectOutboxMetrics: appInstance.locals.collectOutboxMetrics, onStatusChange: (status) => updateWorkerStatus(name, required, status) });
        workerStops.push({ name, stop: typeof stop === "function" ? stop : worker.stop?.bind(worker) });
        workers[name] = { ...sanitizedWorkerState(worker.getStatus?.() ?? { state: "running" }), required };
      } catch {
        const previousState = workers[name]?.state ?? "starting";
        recordWorkerStateMetrics(appInstance.locals?.operationalMetrics, name, previousState, "failed");
        workers[name] = { ...sanitizedWorkerState({ state: "failed", consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastErrorCode: "WORKER_START_FAILED" }), required };
        notifyWorkerTransition(name, required, previousState, "failed");
      }
    }
    publishStatus();
  });
  server.listen(port);
  return { server, shutdown, lifecycleStatus };
};

export const startConfiguredServer = async ({ environment = getEnv(), dependenciesLoader = loadApplicationDependencies, createApplication = createApp, ...options } = {}) => {
  const dependencies = environment.nodeEnv === "production" ? await dependenciesLoader(environment) : {};
  const appInstance = createApplication(environment, dependencies);
  return startServer(environment.port, { ...options, appInstance, drainTimeoutMs: environment.shutdown?.drainTimeoutMs });
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  void startConfiguredServer().then(({ shutdown }) => {
    const closeOnSignal = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", closeOnSignal);
    process.once("SIGTERM", closeOnSignal);
  }).catch(() => {
    // Configuration and adapter failures are intentionally sanitized.
    process.exitCode = 1;
  });
}
