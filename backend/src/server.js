import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import app from "./app.js";
import { disconnectDatabase } from "./config/db.js";
import { getEnv } from "./config/env.js";
import { closeRateLimitStore } from "./services/rate-limit-store.service.js";

export const startServer = (
  port = getEnv().port,
  { disconnectDatabase: disconnectDatabaseResource = disconnectDatabase } = {},
) => {
  const server = createServer(app);
  let shutdownPromise;

  const shutdown = () => {
    shutdownPromise ??= (async () => {
      let shutdownFailed = false;

      try {
        await new Promise((resolveClose, reject) => {
          server.close((error) => {
            if (error) return reject(error);
            resolveClose();
          });
        });
      } catch {
        shutdownFailed = true;
      }

      try {
        await disconnectDatabaseResource();
      } catch {
        shutdownFailed = true;
      }

      try {
        await closeRateLimitStore();
      } catch {
        shutdownFailed = true;
      }

      if (shutdownFailed) throw new Error("Graceful server shutdown failed");
    })();

    return shutdownPromise;
  };

  server.listen(port);
  return { server, shutdown };
};

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const { shutdown } = startServer();
  const closeOnSignal = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", closeOnSignal);
  process.once("SIGTERM", closeOnSignal);
}
