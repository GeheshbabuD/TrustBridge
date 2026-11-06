import test from "node:test";
import assert from "node:assert/strict";
import { loadApplicationDependencies } from "../../src/config/application-composition.js";
import { createApp } from "../../src/app.js";
import { startConfiguredServer } from "../../src/server.js";
import { validateEnv } from "../../src/config/env.js";
import { once } from "node:events";

const production = validateEnv({
  NODE_ENV: "production", DATABASE_URL: "postgresql://synthetic:synthetic@localhost:5432/trustbridge_test",
  JWT_ACCESS_SECRET: "synthetic-access-key-with-entropy-0123456789", JWT_REFRESH_SECRET: "synthetic-refresh-key-with-entropy-9876543210",
  RATE_LIMIT_STORE: "redis", REDIS_URL: "rediss://user:synthetic-password@redis.invalid:6380/0",
  RATE_LIMIT_KEY_SECRET: "synthetic-independent-rate-limit-key-0123456789",
  MFA_ENCRYPTION_PROVIDER: "kms", MFA_KMS_KEY_ID: "synthetic-key", MFA_KMS_KEY_VERSION: "1",
  TRUSTBRIDGE_COMPOSITION_MODULE: "./deployment-adapters.js",
});
const kms = {
  kind: "kms-envelope", keyId: "synthetic-key", keyVersion: 1,
  async encryptSecret() {}, async decryptSecret() {}, async checkAvailability() {},
};
const store = { shared: true, increment: async () => ({ hits: 1 }), healthCheck: async () => ({ available: true, shared: true }) };

test("production composition loads operator adapters without exposing configuration", async () => {
  const dependencies = await loadApplicationDependencies(production, {
    importer: async (url) => {
      assert.match(url, /deployment-adapters\.js$/);
      return { createApplicationDependencies: async ({ environment }) => {
        assert.equal(environment.nodeEnv, "production");
        return { mfaEncryptionProvider: kms, rateLimitStore: store };
      } };
    },
  });
  const app = createApp(production, dependencies);
  assert.equal(typeof app, "function");
  assert.equal(JSON.stringify(dependencies).includes("synthetic-password"), false);
});

test("normal configured server startup passes production adapters into createApp", async () => {
  const dependencies = { mfaEncryptionProvider: kms };
  let received;
  const app = Object.assign((_request, response) => response.end(), { locals: {} });
  const runtime = await startConfiguredServer({
    environment: production,
    dependenciesLoader: async () => dependencies,
    createApplication: (environment, injected) => { received = { environment, injected }; return app; },
    disconnectDatabase: async () => {},
    closeRateLimitStore: async () => {},
  });
  await once(runtime.server, "listening");
  assert.strictEqual(received.injected, dependencies);
  await runtime.shutdown();
});

test("production composition fails closed when module, KMS adapter, or contract is invalid", async () => {
  await assert.rejects(loadApplicationDependencies(production, { modulePath: null }), /not configured/);
  await assert.rejects(loadApplicationDependencies(production, { importer: async () => ({ createApplicationDependencies: async () => ({}) }) }), /KMS adapter is required/);
  await assert.rejects(loadApplicationDependencies(production, { importer: async () => ({ createApplicationDependencies: async () => ({ mfaEncryptionProvider: kms, mfaService: { checkEncryptionAvailability: async () => true } }) }) }), /must be composed with the validated KMS adapter/);
  await assert.rejects(loadApplicationDependencies(production, { importer: async () => ({ createApplicationDependencies: async () => ({ mfaEncryptionProvider: kms, rateLimitStore: { shared: false, increment: async () => {}, healthCheck: async () => {} } }) }) }), /must be shared/);
  await assert.rejects(loadApplicationDependencies(production, { importer: async () => ({}) }), /composition is invalid/);
  assert.throws(() => createApp(production, { rateLimitStore: store }), /MFA secret cryptographic operation failed/);
  await assert.rejects(startConfiguredServer({ environment: production, dependenciesLoader: async () => ({}), createApplication: createApp }), /MFA secret cryptographic operation failed/);
});

test("development composition remains local and requires no external adapter module", async () => {
  const development = validateEnv({
    NODE_ENV: "development", DATABASE_URL: "postgresql://synthetic:synthetic@localhost:5432/trustbridge_test",
    JWT_ACCESS_SECRET: "synthetic-access-key-with-entropy-0123456789", JWT_REFRESH_SECRET: "synthetic-refresh-key-with-entropy-9876543210",
  });
  assert.deepEqual(await loadApplicationDependencies(development), {});
  assert.equal(typeof createApp(development), "function");
});
