import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { loadApplicationDependencies } from "./config/application-composition.js";
import { disconnectDatabase } from "./config/db.js";
import { closeRateLimitStore } from "./services/rate-limit-store.service.js";

const sanitizedWorkerState = (state) => ({
  state: state.state,
  consecutiveFailures: state.consecutiveFailures ?? 0,
  lastSuccessAt: state.lastSuccessAt ?? null,
  lastFailureAt: state.lastFailureAt ?? null,
  lastErrorCode: state.lastErrorCode ?? null,
});

export const startServer = (port = getEnv().port, options = {}) => {
  const disconnectDatabaseResource = options.disconnectDatabase ?? disconnectDatabase;
  const closeRateLimitResource = options.closeRateLimitStore ?? closeRateLimitStore;
  const appInstance = options.appInstance ?? createApp(getEnv());
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  const workerIntervalMs = options.escrowWorkerIntervalMs ?? 5000;
  const onStatus = options.onStatus ?? (() => {});
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
    ["notification", appInstance.locals?.notificationWorker],
    ["escrow", appInstance.locals?.escrowWorker],
    ["blockchain", appInstance.locals?.blockchainWorker],
  ];
  const stopWorkers = async () => {
    const stops = workerEntries().map(([name, worker]) => {
      if (!worker || workers[name]?.state === "disabled") return Promise.resolve();
      workers[name] = { ...(worker.getStatus?.() ?? {}), state: "stopping" };
      const stop = workerStops.find((entry) => entry.name === name)?.stop ?? worker.stop?.bind(worker);
      if (typeof stop !== "function") {
        workers[name] = { ...(worker.getStatus?.() ?? {}), state: "stopped" };
        return Promise.resolve();
      }
      return Promise.resolve().then(stop).then(() => {
        workers[name] = { ...(worker.getStatus?.() ?? {}), state: "stopped" };
      }).catch(() => {
        workers[name] = { ...(worker.getStatus?.() ?? {}), state: "degraded", lastErrorCode: "WORKER_STOP_FAILED" };
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
          for (const [name, worker] of workerEntries()) {
            if (workers[name]?.state === "stopping") workers[name] = { ...(worker?.getStatus?.() ?? {}), state: "drain_timeout", lastErrorCode: "DRAIN_TIMEOUT" };
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
    for (const [name, worker] of workerEntries()) {
      if (!worker || typeof worker.start !== "function") {
        workers[name] = { state: "disabled" };
        continue;
      }
      try {
        const stop = worker.start({ intervalMs: workerIntervalMs });
        workerStops.push({ name, stop: typeof stop === "function" ? stop : worker.stop?.bind(worker) });
        workers[name] = { ...(worker.getStatus?.() ?? {}), state: "running" };
      } catch {
        workers[name] = { state: "failed", consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastErrorCode: "WORKER_START_FAILED" };
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
