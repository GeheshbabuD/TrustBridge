import { createClient } from "@redis/client";

const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { hits, redis.call('PTTL', KEYS[1]) }
`;
const DECREMENT_SCRIPT = `
local hits = redis.call('DECR', KEYS[1])
if hits <= 0 then redis.call('DEL', KEYS[1]); return 0 end
return hits
`;
const COMMAND_TIMEOUT_MS = 5000;
const withTimeout = (promise) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new RateLimitStoreUnavailableError()), COMMAND_TIMEOUT_MS);
  timer.unref?.();
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

export class RateLimitStoreUnavailableError extends Error {
  constructor() {
    super("Shared rate-limit storage is unavailable");
    this.name = "RateLimitStoreUnavailableError";
  }
}

export class MemoryRateLimitStore {
  #buckets = new Map();
  kind = "memory";
  shared = false;

  async increment(key, windowMs, now = Date.now()) {
    const current = this.#buckets.get(key);
    if (!current || current.resetAt <= now) {
      const next = { hits: 1, resetAt: now + windowMs };
      this.#buckets.set(key, next);
      return next;
    }
    current.hits += 1;
    return { ...current };
  }

  async healthCheck() {
    return { available: true, shared: false };
  }

  async decrement(key) {
    const current = this.#buckets.get(key);
    if (!current) return;
    current.hits -= 1;
    if (current.hits <= 0) this.#buckets.delete(key);
  }
}

export class RedisRateLimitStore {
  #client;
  #connectPromise;
  kind = "redis";
  shared = true;

  constructor({ client }) {
    this.#client = client;
    // Redis clients emit connection errors; callers receive only a sanitized error.
    this.#client.on("error", () => {});
  }

  async #ready() {
    if (this.#client.isReady) return;
    if (!this.#connectPromise) {
      this.#connectPromise = withTimeout(this.#client.connect()).catch(() => {
        this.#connectPromise = undefined;
        throw new RateLimitStoreUnavailableError();
      });
    }
    await this.#connectPromise;
    if (!this.#client.isReady) throw new RateLimitStoreUnavailableError();
  }

  async increment(key, windowMs) {
    try {
      await this.#ready();
      const [hits, ttl] = await withTimeout(this.#client.eval(INCREMENT_SCRIPT, {
        keys: [key],
        arguments: [String(windowMs)],
      }));
      if (!Number.isSafeInteger(Number(hits)) || Number(ttl) < 0) {
        throw new RateLimitStoreUnavailableError();
      }
      return { hits: Number(hits), resetAt: Date.now() + Number(ttl) };
    } catch {
      throw new RateLimitStoreUnavailableError();
    }
  }

  async healthCheck() {
    try {
      await this.#ready();
      await withTimeout(this.#client.ping());
      return { available: true, shared: true };
    } catch {
      return { available: false, shared: true };
    }
  }

  async decrement(key) {
    try {
      await this.#ready();
      await withTimeout(this.#client.eval(DECREMENT_SCRIPT, { keys: [key], arguments: [] }));
    } catch {
      throw new RateLimitStoreUnavailableError();
    }
  }

  async close() {
    if (this.#client.isOpen) await this.#client.quit().catch(() => {});
  }
}

let configuredStore;
let configuredStoreSignature;

export const getRateLimitStore = (configuration) => {
  if (configuration.store !== "redis") return configuredStore?.kind === "memory"
    ? configuredStore
    : (configuredStore = new MemoryRateLimitStore());

  const signature = configuration.redisUrl;
  if (configuredStore?.kind === "redis" && configuredStoreSignature === signature) return configuredStore;
  const client = createClient({
    url: configuration.redisUrl,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: (attempts) => Math.min(attempts * 200, 3000) },
  });
  configuredStore = new RedisRateLimitStore({ client });
  configuredStoreSignature = signature;
  return configuredStore;
};

export const closeRateLimitStore = async () => {
  if (configuredStore?.kind === "redis") await configuredStore.close();
  configuredStore = undefined;
  configuredStoreSignature = undefined;
};
