import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSharedRateLimiter } from "../../src/middleware/rateLimit.middleware.js";
import { MemoryRateLimitStore, RedisRateLimitStore, RateLimitStoreUnavailableError } from "../../src/services/rate-limit-store.service.js";

test("memory store increments atomically and expires at its fixed window boundary", async () => {
  const store = new MemoryRateLimitStore();
  const results = await Promise.all(Array.from({ length: 50 }, () => store.increment("bucket", 1000, 10_000)));
  assert.equal(Math.max(...results.map((result) => result.hits)), 50);
  assert.deepEqual(await store.increment("bucket", 1000, 11_000), { hits: 1, resetAt: 12_000 });
});

test("separate middleware instances share account and operation buckets without trusting forwarded IP", async () => {
  const backing = new MemoryRateLimitStore();
  const observedKeys = [];
  const store = { increment: async (key, windowMs) => { observedKeys.push(key); return backing.increment(key, windowMs); } };
  const options = { store, keySecret: "a-test-only-key-that-is-never-a-production-secret", windowMs: 60_000, max: 1, operation: "login", family: "authentication", accountScope: "credentials" };
  const first = createSharedRateLimiter(options);
  const second = createSharedRateLimiter({ ...options, operation: "registration" });
  const invoke = (middleware, email, forwardedFor = "198.51.100.5") => new Promise((resolve) => {
    const response = new EventEmitter();
    response.setHeader = () => {};
    const remoteAddress = forwardedFor === "198.51.100.5" ? "127.0.0.1" : "127.0.0.2";
    middleware({ body: { email }, socket: { remoteAddress }, headers: { "x-forwarded-for": forwardedFor } }, response, (error) => resolve(error ?? null));
  });

  assert.equal(await invoke(first, " PERSON@example.test "), null);
  const sameAccountFromOtherForwardedIp = await invoke(second, "person@example.test", "203.0.113.77");
  assert.equal(sameAccountFromOtherForwardedIp.statusCode, 429);
  assert.equal(sameAccountFromOtherForwardedIp.code, "RATE_LIMIT_EXCEEDED");
  const differentAccountFromSameIp = await invoke(first, "other@example.test");
  assert.equal(differentAccountFromSameIp.statusCode, 429);
  assert.ok(observedKeys.every((key) => !key.includes("person@example.test") && !key.includes("127.0.0.")));
});

test("shared store outage fails closed with a generic 503 and recovers after service restoration", async () => {
  let available = false;
  const store = {
    async increment() {
      if (!available) throw new RateLimitStoreUnavailableError();
      return { hits: 1, resetAt: Date.now() + 60_000 };
    },
  };
  const middleware = createSharedRateLimiter({ store, windowMs: 60_000, max: 5, operation: "verify" });
  const invoke = () => new Promise((resolve) => middleware({ socket: { remoteAddress: "127.0.0.1" } }, { setHeader() {} }, resolve));
  const failure = await invoke();
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.code, "RATE_LIMIT_STORE_UNAVAILABLE");
  assert.doesNotMatch(failure.message, /redis|credential|secret|127\.0\.0\.1/i);
  available = true;
  assert.equal(await invoke(), undefined);
});

test("Redis store applies atomic increment-and-expiry script and sanitizes client failures", async () => {
  class FakeRedis extends EventEmitter {
    isReady = true;
    async eval(script, options) {
      assert.match(script, /INCR/);
      assert.match(script, /PEXPIRE/);
      assert.deepEqual(options.arguments, ["10000"]);
      return [3, 9999];
    }
    async ping() { return "PONG"; }
  }
  const store = new RedisRateLimitStore({ client: new FakeRedis() });
  const increment = await store.increment("hashed-key", 10_000);
  assert.equal(increment.hits, 3);
  assert.ok(increment.resetAt > Date.now() && increment.resetAt <= Date.now() + 10_000);
  assert.deepEqual(await store.healthCheck(), { available: true, shared: true });

  class FailedRedis extends FakeRedis { async eval() { throw new Error("private redis endpoint detail"); } }
  await assert.rejects(new RedisRateLimitStore({ client: new FailedRedis() }).increment("key", 1000), RateLimitStoreUnavailableError);
});
