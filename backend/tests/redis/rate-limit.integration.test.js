import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import test from "node:test";
import { createClient } from "@redis/client";
import { RedisRateLimitStore } from "../../src/services/rate-limit-store.service.js";
import { createSharedRateLimiter } from "../../src/middleware/rateLimit.middleware.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "redis-integration-access-key-for-tests-012345";
process.env.JWT_REFRESH_SECRET = "redis-integration-refresh-key-for-tests-678901";
const [{ createApp }, { validateEnv }] = await Promise.all([
  import("../../src/app.js"),
  import("../../src/config/env.js"),
]);

const testUrl = process.env.TRUSTBRIDGE_REDIS_TEST_URL;
const run = process.env.TRUSTBRIDGE_REDIS_TESTS === "1" && typeof testUrl === "string";

test("isolated Redis shares counters across app instances and expires buckets", { skip: !run ? "requires dedicated loopback Redis database 15 and TRUSTBRIDGE_REDIS_TESTS=1" : false }, async () => {
  const target = new URL(testUrl);
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname), "Redis integration target must be loopback");
  assert.equal(target.pathname, "/15", "Redis integration must use isolated logical database 15");
  const firstClient = createClient({ url: testUrl, disableOfflineQueue: true });
  const secondClient = createClient({ url: testUrl, disableOfflineQueue: true });
  const first = new RedisRateLimitStore({ client: firstClient });
  const second = new RedisRateLimitStore({ client: secondClient });
  const prefix = `tb:rl:test:${randomUUID()}`;
  const environment = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/trustbridge_test",
    JWT_ACCESS_SECRET: "redis-integration-access-key-for-tests-012345",
    JWT_REFRESH_SECRET: "redis-integration-refresh-key-for-tests-678901",
    RATE_LIMIT_KEY_SECRET: `redis-integration-hmac-${randomUUID()}`,
    API_RATE_LIMIT_WINDOW_MS: "60000",
    API_RATE_LIMIT_MAX: "1",
  });
  const appA = createApp(environment, { rateLimitStore: first, writeLog: () => {} });
  const appB = createApp(environment, { rateLimitStore: second, writeLog: () => {} });
  const serverA = appA.listen(0);
  const serverB = appB.listen(0);
  let outageProxy;
  let outageStore;
  try {
    await Promise.all([once(serverA, "listening"), once(serverB, "listening")]);
    const availability = await Promise.all([first.healthCheck(), second.healthCheck()]);
    assert.deepEqual(availability, [{ available: true, shared: true }, { available: true, shared: true }]);
    const addressA = serverA.address();
    const addressB = serverB.address();
    const firstRequest = await fetch(`http://127.0.0.1:${addressA.port}/api/v1/rate-test`);
    const secondRequest = await fetch(`http://127.0.0.1:${addressB.port}/api/v1/rate-test`);
    assert.equal(firstRequest.status, 404);
    assert.equal(secondRequest.status, 429, "the second app must observe the first app's shared counter");
    const results = await Promise.all([
      ...Array.from({ length: 30 }, () => first.increment(`${prefix}:shared`, 1500)),
      ...Array.from({ length: 30 }, () => second.increment(`${prefix}:shared`, 1500)),
    ]);
    assert.equal(Math.max(...results.map((bucket) => bucket.hits)), 60);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal((await second.increment(`${prefix}:shared`, 1500)).hits, 1);

    const invoke = (middleware, email, remoteAddress, forwardedFor) => new Promise((resolve) => {
      const response = { setHeader() {} };
      middleware({ body: { email }, socket: { remoteAddress }, headers: { "x-forwarded-for": forwardedFor } }, response, (error) => resolve(error ?? null));
    });
    const accountPolicy = `account-${randomUUID()}`;
    const accountLimitA = createSharedRateLimiter({ store: first, keySecret: environment.rateLimit.keySecret, windowMs: 60_000, max: 1, operation: accountPolicy, family: "redis-integration", accountScope: "credential" });
    const accountLimitB = createSharedRateLimiter({ store: second, keySecret: environment.rateLimit.keySecret, windowMs: 60_000, max: 1, operation: accountPolicy, family: "redis-integration", accountScope: "credential" });
    assert.equal(await invoke(accountLimitA, " User@example.test ", "127.0.0.2", "203.0.113.8"), null);
    assert.equal((await invoke(accountLimitB, "user@example.test", "127.0.0.3", "203.0.113.9")).statusCode, 429, "normalized account bucket is shared across IPs and clients");

    const ipPolicy = `ip-${randomUUID()}`;
    const ipLimitA = createSharedRateLimiter({ store: first, keySecret: environment.rateLimit.keySecret, windowMs: 60_000, max: 1, operation: ipPolicy, family: "redis-integration", accountScope: "credential" });
    const ipLimitB = createSharedRateLimiter({ store: second, keySecret: environment.rateLimit.keySecret, windowMs: 60_000, max: 1, operation: ipPolicy, family: "redis-integration", accountScope: "credential" });
    assert.equal(await invoke(ipLimitA, "first@example.test", "127.0.0.4", "198.51.100.1"), null);
    assert.equal((await invoke(ipLimitB, "second@example.test", "127.0.0.4", "198.51.100.2")).statusCode, 429, "socket IP operation bucket ignores spoofed forwarding headers");

    let forwarding = true;
    const proxyPairs = new Set();
    outageProxy = createServer((downstream) => {
      if (!forwarding) return downstream.destroy();
      const upstream = connect({ host: "127.0.0.1", port: 6380 });
      const pair = { downstream, upstream };
      proxyPairs.add(pair);
      const remove = () => proxyPairs.delete(pair);
      downstream.once("close", remove);
      upstream.once("close", remove);
      upstream.once("connect", () => {
        if (!forwarding) return pairClose(pair);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
      const pairClose = ({ downstream: clientSocket, upstream: serverSocket }) => {
        clientSocket.destroy();
        serverSocket.destroy();
      };
      downstream.once("error", remove);
      upstream.once("error", remove);
    });
    outageProxy.listen(0, "127.0.0.1");
    await once(outageProxy, "listening");
    const proxyPort = outageProxy.address().port;
    const outageClient = createClient({
      url: `redis://127.0.0.1:${proxyPort}/15`,
      disableOfflineQueue: true,
      socket: { connectTimeout: 1000, reconnectStrategy: (attempts) => Math.min(attempts * 50, 200) },
    });
    outageStore = new RedisRateLimitStore({ client: outageClient });
    assert.deepEqual(await outageStore.healthCheck(), { available: true, shared: true });
    const outageLimiter = createSharedRateLimiter({ store: outageStore, keySecret: environment.rateLimit.keySecret, windowMs: 60_000, max: 10, operation: `outage-${randomUUID()}` });
    assert.equal(await invoke(outageLimiter, "outage@example.test", "127.0.0.5", "192.0.2.1"), null);
    forwarding = false;
    for (const pair of proxyPairs) {
      pair.downstream.destroy();
      pair.upstream.destroy();
    }
    const deniedDuringOutage = await invoke(outageLimiter, "outage@example.test", "127.0.0.5", "192.0.2.1");
    assert.equal(deniedDuringOutage.statusCode, 503, "Redis connection loss must fail the limiter closed");
    forwarding = true;
    const recoveryDeadline = Date.now() + 8000;
    let recovered = false;
    while (Date.now() < recoveryDeadline) {
      if ((await outageStore.healthCheck()).available) { recovered = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recovered, true, "Redis connection should recover after forwarding is restored");
    assert.equal(await invoke(outageLimiter, "outage@example.test", "127.0.0.5", "192.0.2.1"), null);
  } finally {
    const closedA = once(serverA, "close");
    const closedB = once(serverB, "close");
    serverA.close();
    serverB.close();
    await Promise.all([closedA, closedB]);
    if (outageStore) await outageStore.close();
    if (outageProxy) {
      const proxyClosed = once(outageProxy, "close");
      outageProxy.close();
      await proxyClosed;
    }
    await Promise.all([first.close(), second.close()]);
  }
});
