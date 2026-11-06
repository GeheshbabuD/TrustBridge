import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "synthetic-access-secret-for-server-test-0123456789";
process.env.JWT_REFRESH_SECRET = "synthetic-refresh-secret-for-server-test-9876543210";
const { startServer } = await import("../../src/server.js");

test("HTTP server starts the configured worker only after listening and stops it before resource shutdown", async () => {
  const events = [];
  const appInstance = (_request, _response) => {};
  appInstance.locals = { escrowWorker: { start() { events.push("worker-start"); return async () => events.push("worker-stop"); } } };
  const { server, shutdown } = startServer(0, {
    appInstance,
    disconnectDatabase: async () => events.push("db-close"),
    closeRateLimitStore: async () => events.push("rate-limit-close"),
  });
  await once(server, "listening");
  assert.deepEqual(events, ["worker-start"]);
  await shutdown();
  assert.deepEqual(events, ["worker-start", "worker-stop", "db-close", "rate-limit-close"]);
});
