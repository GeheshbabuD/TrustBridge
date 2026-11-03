import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseLifecycle, DatabaseLifecycleError } from "../../src/config/db.js";

const makeClient = (overrides = {}) => ({
  connectCalls: 0,
  disconnectCalls: 0,
  async $connect() { this.connectCalls += 1; },
  async $disconnect() { this.disconnectCalls += 1; },
  ...overrides,
});

test("database client initialization and connection are shared", async () => {
  let createCalls = 0;
  const client = makeClient();
  const lifecycle = createDatabaseLifecycle({ createClient: async () => { createCalls += 1; return client; } });

  const [first, second] = await Promise.all([lifecycle.getClient(), lifecycle.getClient()]);
  assert.strictEqual(first, second);
  assert.equal(createCalls, 1);
  assert.deepEqual(await Promise.all([lifecycle.connect(), lifecycle.connect()]), [client, client]);
  assert.equal(client.connectCalls, 1);
});

test("client initialization failures are sanitized and can be retried", async () => {
  const secret = "postgresql://secret-marker";
  let attempts = 0;
  const client = makeClient();
  const lifecycle = createDatabaseLifecycle({ createClient: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error(secret);
    return client;
  } });

  await assert.rejects(lifecycle.getClient(), (error) => {
    assert.ok(error instanceof DatabaseLifecycleError);
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.strictEqual(await lifecycle.getClient(), client);
});

test("connection failures clean up and expose only a safe error", async () => {
  const secret = "adapter-error-with-secret";
  let attempts = 0;
  const failed = makeClient({ async $connect() { throw new Error(secret); } });
  const recovered = makeClient();
  const lifecycle = createDatabaseLifecycle({ createClient: async () => (++attempts === 1 ? failed : recovered) });

  await assert.rejects(lifecycle.connect(), (error) => {
    assert.equal(error.message, "Database connection failed");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(failed.disconnectCalls, 1);
  assert.strictEqual(await lifecycle.connect(), recovered);
});

test("disconnect is shared, idempotent, and permits a fresh client later", async () => {
  const client = makeClient();
  let createCalls = 0;
  const lifecycle = createDatabaseLifecycle({ createClient: async () => { createCalls += 1; return client; } });
  await lifecycle.connect();

  await Promise.all([lifecycle.disconnect(), lifecycle.disconnect()]);
  assert.equal(client.disconnectCalls, 1);
  await lifecycle.disconnect();
  assert.equal(client.disconnectCalls, 1);
  await lifecycle.getClient();
  assert.equal(createCalls, 2);
});

test("disconnect errors are sanitized", async () => {
  const secret = "private-adapter-error";
  const lifecycle = createDatabaseLifecycle({ createClient: async () => makeClient({
    async $disconnect() { throw new Error(secret); },
  }) });
  await lifecycle.getClient();

  await assert.rejects(lifecycle.disconnect(), (error) => {
    assert.equal(error.message, "Database disconnection failed");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("creating the lifecycle does not initialize a client", async () => {
  let createCalls = 0;
  createDatabaseLifecycle({ createClient: async () => { createCalls += 1; return makeClient(); } });
  assert.equal(createCalls, 0);
});
