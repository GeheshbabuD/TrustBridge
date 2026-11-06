import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvironmentConfigError,
  getDatabaseUrl,
  validateEnv,
} from "../../src/config/env.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://trustbridge:local-only@127.0.0.1:5432/trustbridge",
  JWT_ACCESS_SECRET: "access-secret-for-tests-0123456789-A",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests-987654321-B",
};

const expectConfigError = (environment) => {
  assert.throws(() => validateEnv(environment), EnvironmentConfigError);
};

test("validates required values and applies development defaults", () => {
  const config = validateEnv(validEnvironment);

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.port, 3000);
  assert.deepEqual(config.corsAllowedOrigins, []);
  assert.deepEqual({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }, { windowMs: 900000, max: 100 });
  assert.equal(config.rateLimit.store, "memory");
  assert.deepEqual(config.password, { bcryptSaltRounds: 12 });
  assert.equal(config.database.url, validEnvironment.DATABASE_URL);
  assert.equal(config.jwt.accessTtl, "15m");
  assert.equal(config.jwt.refreshTtl, "7d");
  assert.equal(config.jwt.algorithm, "HS256");
  assert.equal(config.integrations.payment.escrowExecutionEnabled, false);
  assert.equal(config.integrations.payment.refundsApproved, false);
  assert.equal(config.integrations.payment.routeApproved, false);
});

test("financial execution requires explicit Razorpay configuration and defaults disabled", () => {
  const approved = validateEnv({
    ...validEnvironment,
    PAYMENT_ENABLED: "true", PAYMENT_PROVIDER: "razorpay", PAYMENT_API_KEY: "synthetic-key",
    PAYMENT_API_SECRET: "synthetic-secret", PAYMENT_WEBHOOK_SECRET: "synthetic-webhook-secret-012345",
    ESCROW_EXECUTION_ENABLED: "true", RAZORPAY_REFUNDS_APPROVED: "true", RAZORPAY_ROUTE_APPROVED: "true",
  });
  assert.deepEqual(approved.integrations.payment, {
    enabled: true, provider: "razorpay", escrowExecutionEnabled: true, refundsApproved: true, routeApproved: true,
  });
  for (const environment of [
    { ...validEnvironment, ESCROW_EXECUTION_ENABLED: "true" },
    { ...validEnvironment, RAZORPAY_REFUNDS_APPROVED: "true" },
    { ...validEnvironment, RAZORPAY_ROUTE_APPROVED: "true" },
    { ...validEnvironment, PAYMENT_ENABLED: "true", PAYMENT_PROVIDER: "mock" },
  ]) assert.throws(() => validateEnv(environment), EnvironmentConfigError);
});

test("rejects missing required environment variables with field names", () => {
  assert.throws(
    () => validateEnv({}),
    (error) => {
      assert.ok(error instanceof EnvironmentConfigError);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_ACCESS_SECRET/);
      assert.match(error.message, /JWT_REFRESH_SECRET/);
      return true;
    },
  );
});

test("rejects invalid ports", () => {
  for (const PORT of ["0", "65536", "-1", "abc", "3.5"]) {
    assert.throws(
      () => validateEnv({ ...validEnvironment, PORT }),
      /PORT must be an integer from 1 through 65535/,
    );
  }
});

test("rejects unsupported NODE_ENV values", () => {
  expectConfigError({ ...validEnvironment, NODE_ENV: "staging" });
});

test("accepts exact CORS origins and rejects wildcards or paths safely", () => {
  const config = validateEnv({
    ...validEnvironment,
    CORS_ALLOWED_ORIGINS: "https://app.example.test,http://localhost:5173",
    API_RATE_LIMIT_WINDOW_MS: "60000",
    API_RATE_LIMIT_MAX: "12",
  });

  assert.deepEqual(config.corsAllowedOrigins, [
    "https://app.example.test",
    "http://localhost:5173",
  ]);
  assert.deepEqual({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }, { windowMs: 60000, max: 12 });

  for (const CORS_ALLOWED_ORIGINS of ["*", "https://app.example.test/private"]) {
    assert.throws(
      () => validateEnv({ ...validEnvironment, CORS_ALLOWED_ORIGINS }),
      /CORS_ALLOWED_ORIGINS/,
    );
  }
});

test("validates API rate-limit settings", () => {
  for (const env of [
    { ...validEnvironment, API_RATE_LIMIT_WINDOW_MS: "999" },
    { ...validEnvironment, API_RATE_LIMIT_WINDOW_MS: "not-a-number" },
    { ...validEnvironment, API_RATE_LIMIT_MAX: "0" },
    { ...validEnvironment, API_RATE_LIMIT_MAX: "10001" },
  ]) {
    expectConfigError(env);
  }
});

test("production rate limiting requires TLS Redis, ACL credentials and a hidden key secret", () => {
  const production = {
    ...validEnvironment,
    NODE_ENV: "production",
    RATE_LIMIT_STORE: "redis",
    REDIS_URL: "rediss://acl-user:synthetic-redis-password@redis.example.test:6380/0",
    RATE_LIMIT_KEY_SECRET: "separate-rate-limit-key-secret-0123456789",
    MFA_ENCRYPTION_PROVIDER: "kms",
    MFA_KMS_KEY_ID: "projects/test/keys/mfa",
    MFA_KMS_KEY_VERSION: "1",
  };
  const config = validateEnv(production);
  assert.equal(config.rateLimit.store, "redis");
  assert.equal(Object.keys(config.rateLimit).includes("redisUrl"), false);
  assert.equal(Object.keys(config.rateLimit).includes("keySecret"), false);
  assert.equal(JSON.stringify(config).includes("synthetic-redis-password"), false);

  for (const invalid of [
    { ...production, RATE_LIMIT_STORE: "memory" },
    { ...production, REDIS_URL: "redis://acl-user:synthetic-redis-password@redis.example.test:6379/0" },
    { ...production, REDIS_URL: "rediss://redis.example.test:6380/0" },
    { ...production, RATE_LIMIT_KEY_SECRET: undefined },
    { ...production, MFA_ENCRYPTION_PROVIDER: "local" },
    { ...production, MFA_KMS_KEY_ID: undefined },
    { ...production, MFA_KMS_KEY_VERSION: undefined },
  ]) assert.throws(() => validateEnv(invalid), EnvironmentConfigError);
});

test("validates MFA login challenge lifetime, assurance age, and auth rate limits", () => {
  const defaults = validateEnv(validEnvironment);
  assert.deepEqual(defaults.mfa.loginRateLimit, { windowMs: 900000, max: 10 });
  assert.deepEqual(defaults.mfa.challengeRateLimit, { windowMs: 600000, max: 5 });
  assert.equal(defaults.mfa.loginChallengeTtlSeconds, 300);
  assert.equal(defaults.mfa.stepUpChallengeTtlSeconds, 300);
  assert.equal(defaults.mfa.assuranceMaxAgeSeconds, 900);

  for (const env of [
    { MFA_LOGIN_CHALLENGE_TTL_SECONDS: "59" },
    { MFA_STEP_UP_CHALLENGE_TTL_SECONDS: "59" },
    { MFA_LOGIN_CHALLENGE_TTL_SECONDS: "901" },
    { MFA_ASSURANCE_MAX_AGE_SECONDS: "59" },
    { MFA_ASSURANCE_MAX_AGE_SECONDS: "3601" },
    { AUTH_LOGIN_RATE_LIMIT_MAX: "0" },
    { MFA_CHALLENGE_RATE_LIMIT_MAX: "51" },
  ]) assert.throws(() => validateEnv({ ...validEnvironment, ...env }), EnvironmentConfigError);
});

test("validates configurable bcrypt work factor with a secure default and bounds", () => {
  assert.equal(validateEnv(validEnvironment).password.bcryptSaltRounds, 12);
  assert.equal(validateEnv({ ...validEnvironment, BCRYPT_SALT_ROUNDS: "14" }).password.bcryptSaltRounds, 14);

  for (const BCRYPT_SALT_ROUNDS of ["11", "16", "12.5", "not-a-number"]) {
    assert.throws(
      () => validateEnv({ ...validEnvironment, BCRYPT_SALT_ROUNDS }),
      /BCRYPT_SALT_ROUNDS must be an integer from 12 through 15/,
    );
  }
});

test("requires a valid PostgreSQL URL", () => {
  for (const DATABASE_URL of ["", "not-a-url", "mysql://user:pass@localhost/db"]) {
    assert.throws(
      () => validateEnv({ ...validEnvironment, DATABASE_URL }),
      /DATABASE_URL must be a valid PostgreSQL URL/,
    );
  }
});

test("Prisma configuration receives a validated database URL", () => {
  assert.equal(getDatabaseUrl(validEnvironment), validEnvironment.DATABASE_URL);
  assert.throws(() => getDatabaseUrl({ DATABASE_URL: "secret-invalid-value" }), /DATABASE_URL/);
});

test("DATABASE_URL is required and missing configuration fails with a safe field-only error", () => {
  assert.throws(
    () => getDatabaseUrl({}),
    (error) => {
      assert.ok(error instanceof EnvironmentConfigError);
      assert.match(error.message, /DATABASE_URL must be a valid PostgreSQL URL/);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\/|password|credential/i);
      return true;
    },
  );
});

test("invalid database URL credentials are never echoed by configuration errors", () => {
  const privateMarker = "synthetic-private-password-987654321";
  assert.throws(
    () => getDatabaseUrl({ DATABASE_URL: `mysql://user:${privateMarker}@localhost/test` }),
    (error) => {
      assert.ok(error instanceof EnvironmentConfigError);
      assert.match(error.message, /DATABASE_URL/);
      assert.equal(error.message.includes(privateMarker), false);
      assert.equal(String(error.stack).includes(privateMarker), false);
      return true;
    },
  );
});

test("requires distinct, sufficiently long JWT secrets", () => {
  for (const env of [
    { ...validEnvironment, JWT_ACCESS_SECRET: undefined },
    { ...validEnvironment, JWT_REFRESH_SECRET: undefined },
    { ...validEnvironment, JWT_ACCESS_SECRET: "short" },
    { ...validEnvironment, JWT_REFRESH_SECRET: validEnvironment.JWT_ACCESS_SECRET },
  ]) {
    expectConfigError(env);
  }
});

test("limits JWT token lifetimes to safe durations", () => {
  for (const env of [
    { ...validEnvironment, JWT_ACCESS_TTL: "forever" },
    { ...validEnvironment, JWT_ACCESS_TTL: "2d" },
    { ...validEnvironment, JWT_REFRESH_TTL: "100d" },
  ]) {
    expectConfigError(env);
  }
});

test("does not require provider credentials while integrations are disabled", () => {
  const config = validateEnv(validEnvironment);

  assert.equal(config.integrations.ai.enabled, false);
  assert.equal(config.integrations.blockchain.enabled, false);
  assert.equal(config.integrations.payment.enabled, false);
  assert.equal(config.integrations.ai.apiKey, undefined);
  assert.equal(config.integrations.payment.apiSecret, undefined);
});

test("local MFA encryption key is optional, hidden, validated, and forbidden in production", () => {
  const marker = Buffer.alloc(32, 0x5a).toString("base64");
  assert.equal(validateEnv(validEnvironment).mfa.localKeyConfigured, false);
  const configured = validateEnv({ ...validEnvironment, MFA_LOCAL_ENCRYPTION_KEY: marker });
  assert.equal(configured.mfa.localKeyConfigured, true);
  assert.equal(configured.mfa.localEncryptionKey.length, 32);
  assert.equal(JSON.stringify(configured).includes(marker), false);
  assert.throws(() => validateEnv({ ...validEnvironment, MFA_LOCAL_ENCRYPTION_KEY: "not-a-key" }), /MFA_LOCAL_ENCRYPTION_KEY/);
  assert.throws(() => validateEnv({ ...validEnvironment, NODE_ENV: "production", MFA_LOCAL_ENCRYPTION_KEY: marker }), /MFA_LOCAL_ENCRYPTION_KEY/);
  const production = validateEnv({ ...validEnvironment, NODE_ENV: "production", RATE_LIMIT_STORE: "redis", REDIS_URL: "rediss://acl-user:synthetic-redis-password@redis.example.test:6380/0", RATE_LIMIT_KEY_SECRET: "separate-rate-limit-key-secret-0123456789", MFA_ENCRYPTION_PROVIDER: "kms", MFA_KMS_KEY_ID: "projects/test/keys/mfa", MFA_KMS_KEY_VERSION: "1" });
  assert.equal(production.mfa.encryptionProvider, "kms");
  assert.equal(production.mfa.kmsKeyVersion, 1);
  assert.throws(() => validateEnv({ ...validEnvironment, NODE_ENV: "production", RATE_LIMIT_STORE: "redis", REDIS_URL: "rediss://acl-user:synthetic-redis-password@redis.example.test:6380/0", RATE_LIMIT_KEY_SECRET: "separate-rate-limit-key-secret-0123456789" }), /MFA_ENCRYPTION_PROVIDER|MFA_KMS_KEY_ID/);
});

test("TOTP clock window defaults to one step and is bounded", () => {
  assert.equal(validateEnv(validEnvironment).mfa.totpWindowSteps, 1);
  assert.equal(validateEnv({ ...validEnvironment, MFA_TOTP_WINDOW_STEPS: "0" }).mfa.totpWindowSteps, 0);
  for (const MFA_TOTP_WINDOW_STEPS of ["-1", "3", "1.5", "bad"]) assert.throws(() => validateEnv({ ...validEnvironment, MFA_TOTP_WINDOW_STEPS }), /MFA_TOTP_WINDOW_STEPS/);
});

test("MFA verification failures have bounded rate-limit configuration", () => {
  assert.deepEqual(validateEnv(validEnvironment).mfa.verificationRateLimit, { windowMs: 600000, max: 5 });
  assert.deepEqual(validateEnv({ ...validEnvironment, MFA_VERIFY_RATE_LIMIT_WINDOW_MS: "30000", MFA_VERIFY_RATE_LIMIT_MAX: "3" }).mfa.verificationRateLimit, { windowMs: 30000, max: 3 });
  for (const env of [
    { ...validEnvironment, MFA_VERIFY_RATE_LIMIT_WINDOW_MS: "999" },
    { ...validEnvironment, MFA_VERIFY_RATE_LIMIT_WINDOW_MS: "3600001" },
    { ...validEnvironment, MFA_VERIFY_RATE_LIMIT_MAX: "0" },
    { ...validEnvironment, MFA_VERIFY_RATE_LIMIT_MAX: "21" },
  ]) assert.throws(() => validateEnv(env), /MFA_VERIFY_RATE_LIMIT/);
});

test("requires credentials and endpoint details only when an integration is enabled", () => {
  assert.throws(
    () => validateEnv({ ...validEnvironment, AI_ENABLED: "true" }),
    /AI_PROVIDER.*AI_API_KEY.*AI_ENDPOINT.*AI_MODEL_IDENTIFIER.*AI_MODEL_VERSION/s,
  );
  assert.throws(
    () => validateEnv({ ...validEnvironment, BLOCKCHAIN_ENABLED: "true" }),
    /BLOCKCHAIN_RPC_URL.*BLOCKCHAIN_CONTRACT_ADDRESS.*BLOCKCHAIN_CHAIN_ID.*BLOCKCHAIN_CONFIRMATIONS/s,
  );
  assert.throws(
    () => validateEnv({ ...validEnvironment, PAYMENT_ENABLED: "true" }),
    /PAYMENT_PROVIDER.*PAYMENT_API_KEY.*PAYMENT_API_SECRET.*PAYMENT_WEBHOOK_SECRET/s,
  );
});

test("accepts complete optional provider configuration", () => {
  const config = validateEnv({
    ...validEnvironment,
    AI_ENABLED: "true",
    AI_PROVIDER: "example-ai",
    AI_API_KEY: "ai-provider-secret",
    AI_ENDPOINT: "https://ai-gateway.example.test/v1/assess",
    AI_MODEL_IDENTIFIER: "risk-model",
    AI_MODEL_VERSION: "2026-01",
    BLOCKCHAIN_ENABLED: "true",
    BLOCKCHAIN_RPC_URL: "https://rpc.example.invalid",
    BLOCKCHAIN_CONTRACT_ADDRESS: "0x1234567890abcdef1234567890abcdef12345678",
    BLOCKCHAIN_CHAIN_ID: "11155111",
    BLOCKCHAIN_CONFIRMATIONS: "12",
    PAYMENT_ENABLED: "true",
    PAYMENT_PROVIDER: "example-payments",
    PAYMENT_API_KEY: "payment-key",
    PAYMENT_API_SECRET: "payment-api-secret",
    PAYMENT_WEBHOOK_SECRET: "payment-webhook-secret",
  });

  assert.equal(config.integrations.ai.enabled, true);
  assert.equal(config.integrations.ai.apiKey, "ai-provider-secret");
  assert.equal(config.integrations.ai.modelIdentifier, "risk-model");
  assert.equal(config.integrations.ai.rateLimit.max, 10);
  assert.equal(config.integrations.blockchain.chainId, 11155111);
  assert.equal(config.integrations.blockchain.confirmations, 12);
  assert.equal(config.integrations.payment.enabled, true);
});

test("enabled production blockchain RPC requires TLS", () => {
  expectConfigError({
    ...validEnvironment,
    NODE_ENV: "production",
    BLOCKCHAIN_ENABLED: "true",
    BLOCKCHAIN_RPC_URL: "http://rpc.example.invalid",
    BLOCKCHAIN_CONTRACT_ADDRESS: "0x1234567890abcdef1234567890abcdef12345678",
    BLOCKCHAIN_CHAIN_ID: "11155111",
    BLOCKCHAIN_CONFIRMATIONS: "12",
  });
});

test("validation errors and serialized config do not disclose secret values or log them", () => {
  const marker = "sensitive-marker-not-for-output-987654321";
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));

  try {
    let thrown;
    try {
      validateEnv({
        ...validEnvironment,
        DATABASE_URL: `not-a-url-${marker}`,
        JWT_ACCESS_SECRET: marker,
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof EnvironmentConfigError);
    assert.equal(String(thrown).includes(marker), false);
    assert.equal(String(thrown.stack).includes(marker), false);
    assert.deepEqual(logged, []);

    const config = validateEnv({
      ...validEnvironment,
      JWT_ACCESS_SECRET: `Access-${marker}-A1`,
      JWT_REFRESH_SECRET: `Refresh-${marker}-B2`,
      BLOCKCHAIN_RPC_URL: `https://rpc.example.invalid/${marker}`,
    });
    assert.equal(JSON.stringify(config).includes(marker), false);
  } finally {
    console.error = originalError;
  }
});
