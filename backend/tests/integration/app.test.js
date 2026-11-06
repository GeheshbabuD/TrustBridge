import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

// Set synthetic test configuration before app.js imports the validated contract.
process.env.NODE_ENV = "test";
process.env.PORT = "3000";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/trustbridge_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-value-with-enough-entropy-123";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-value-with-enough-entropy-456";
process.env.CORS_ALLOWED_ORIGINS = "https://frontend.example.test";

const { default: app, createApp } = await import("../../src/app.js");
const { startServer } = await import("../../src/server.js");
const { getEnv, validateEnv } = await import("../../src/config/env.js");
const { errorHandler } = await import("../../src/middleware/error.middleware.js");
const { ApiError } = await import("../../src/utils/ApiError.js");

const productionEnvironment = () => validateEnv({
  DATABASE_URL: "postgresql://test:test@localhost:5432/trustbridge_test",
  NODE_ENV: "production",
  JWT_ACCESS_SECRET: "production-access-secret-test-value-123456789",
  JWT_REFRESH_SECRET: "production-refresh-secret-test-value-987654321",
  RATE_LIMIT_STORE: "redis",
  REDIS_URL: "rediss://acl-user:synthetic-password@redis.example.test:6380/0",
  RATE_LIMIT_KEY_SECRET: "separate-production-rate-limit-key-123456789",
  MFA_ENCRYPTION_PROVIDER: "kms",
  MFA_KMS_KEY_ID: "test-kms-key",
  MFA_KMS_KEY_VERSION: "1",
});

const testApp = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => { throw new Error("database probe unavailable"); } });
const defaultWorkerStatus = {
  notification: { state: "stopped", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null },
  escrow: { state: "disabled" },
  blockchain: { state: "disabled" },
};
test("configured blockchain execution fails closed without an approved signer adapter", () => {
  const environment = getEnv();
  const enabled = { ...environment, integrations: { ...environment.integrations, blockchain: { enabled: true, chainId: 1337, confirmations: 1, contractAddress: "0x1234567890abcdef1234567890abcdef12345678" } } };
  assert.throws(() => createApp(enabled), /no approved signing adapter is configured/);
});
const withHttpServer = async (run, targetApp = testApp) => {
  const server = targetApp.listen(0);
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

test("Express application can be imported without opening a listener", () => {
  assert.equal(typeof app, "function");
  assert.equal(typeof app.handle, "function");
});

test("server bootstrap can start and close gracefully on an ephemeral port", async () => {
  const shutdownOrder = [];
  const bootstrapApp = Object.assign((_request, response) => response.end(), { locals: {} });
  const { server, shutdown } = startServer(0, {
    appInstance: bootstrapApp,
    disconnectDatabase: async () => {
      assert.equal(server.listening, false);
      shutdownOrder.push("database");
    },
  });
  await once(server, "listening");

  const firstShutdown = shutdown();
  const secondShutdown = shutdown();
  assert.strictEqual(firstShutdown, secondShutdown);
  await Promise.all([firstShutdown, secondShutdown]);

  assert.equal(server.listening, false);
  assert.deepEqual(shutdownOrder, ["database"]);
});

test("health endpoint returns the expected application status", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      message: "TrustBridge backend is running",
      data: { status: "healthy" },
    });
  });
});

test("liveness reports the process while readiness reports database and rate-limit dependencies", async () => {
  await withHttpServer(async (baseUrl) => {
    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), {
      success: true,
      message: "TrustBridge backend is running",
      data: { status: "healthy" },
    });

    const ready = await fetch(`${baseUrl}/health/ready`);
    const payload = await ready.json();
    assert.equal(ready.status, 503);
    assert.deepEqual(payload, {
      success: false,
      message: "Application readiness cannot be confirmed",
      data: { status: "not_ready", checks: { database: "unavailable", rateLimitStore: "process_local", mfaEncryption: "not_required" }, lifecycle: "unmanaged", workers: defaultWorkerStatus },
      error: { code: "READINESS_UNAVAILABLE" },
      requestId: ready.headers.get("x-request-id"),
    });
    assert.equal(JSON.stringify(payload).includes(process.env.DATABASE_URL), false);
    assert.equal(JSON.stringify(payload).includes("node_modules"), false);
  });
});

test("readiness succeeds when database and required local-environment dependencies are available", async () => {
  const readyApp = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => true });
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      status: "ready",
      checks: { database: "available", rateLimitStore: "process_local", mfaEncryption: "not_required" },
      lifecycle: "unmanaged",
      workers: defaultWorkerStatus,
    });
  }, readyApp);
});

test("production readiness reports KMS unavailable without exposing provider details", async () => {
  const production = productionEnvironment();
  const readyApp = createApp(production, {
    writeLog: () => {},
    checkDatabase: async () => true,
    mfaService: { checkEncryptionAvailability: async () => { throw new Error("private KMS endpoint detail"); } },
    rateLimitStore: { shared: true, increment: async () => ({ count: 1 }), healthCheck: async () => ({ available: true, shared: true }) },
  });
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.data.checks.mfaEncryption, "unavailable");
    assert.doesNotMatch(JSON.stringify(payload), /private KMS endpoint detail|synthetic-password/);
  }, readyApp);
});

test("production readiness rejects unavailable shared Redis", async () => {
  const production = productionEnvironment();
  const readyApp = createApp(production, {
    writeLog: () => {},
    checkDatabase: async () => true,
    mfaService: { checkEncryptionAvailability: async () => true },
    rateLimitStore: { shared: true, increment: async () => ({ count: 1 }), healthCheck: async () => ({ available: false, shared: true }) },
  });
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.data.checks.rateLimitStore, "unavailable");
    assert.doesNotMatch(JSON.stringify(payload), /synthetic-password|redis\.example/);
  }, readyApp);
});

test("production readiness succeeds only when database, Redis and KMS are available", async () => {
  const production = productionEnvironment();
  const readyApp = createApp(production, {
    writeLog: () => {},
    checkDatabase: async () => true,
    mfaService: { checkEncryptionAvailability: async () => true },
    rateLimitStore: { shared: true, increment: async () => ({ count: 1 }), healthCheck: async () => ({ available: true, shared: true }) },
  });
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      status: "ready",
      checks: { database: "available", rateLimitStore: "available", mfaEncryption: "available" },
      lifecycle: "unmanaged",
      workers: defaultWorkerStatus,
    });
  }, readyApp);
});

test("shared rate-limit storage outages fail API requests closed and appear in readiness", async () => {
  const unavailableStore = {
    kind: "redis",
    shared: true,
    increment: async () => { throw new Error("synthetic storage outage"); },
    healthCheck: async () => ({ available: false, shared: true }),
  };
  const failingApp = createApp(getEnv(), { writeLog: () => {}, checkDatabase: async () => true, rateLimitStore: unavailableStore });
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.code, "RATE_LIMIT_STORE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(payload), /synthetic storage outage|redis|secret/i);
    const readiness = await fetch(`${baseUrl}/health/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).data.checks.rateLimitStore, "unavailable");
  }, failingApp);
});

test("unknown routes return a JSON 404 response with a stable code and request ID", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/not-registered`);
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 404);
    assert.ok(requestId);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Route not found",
      data: null,
      error: { code: "NOT_FOUND" },
      requestId,
    });
  });
});

test("malformed JSON is rejected without exposing parser details", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/not-registered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      success: false,
      message: "Malformed JSON request body",
      data: null,
      error: { code: "MALFORMED_JSON" },
      requestId: response.headers.get("x-request-id"),
    });
  });
});

test("oversized request bodies receive a safe 413 response", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/not-registered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Request body is too large",
      data: null,
      error: { code: "PAYLOAD_TOO_LARGE" },
      requestId: response.headers.get("x-request-id"),
    });
  });
});

test("Helmet supplies security headers without enabling a CSP", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(response.headers.get("content-security-policy"), null);
  });
});

test("CORS allows configured origins and rejects unlisted origins", async () => {
  await withHttpServer(async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://frontend.example.test" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://frontend.example.test");

    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://unlisted.example.test" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal((await denied.json()).error.code, "CORS_ORIGIN_DENIED");
  });
});

test("CORS preflight succeeds for an allowed API request", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/future-route`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://frontend.example.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-request-id",
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example.test");
    assert.match(response.headers.get("access-control-allow-methods"), /POST/);
    assert.match(response.headers.get("access-control-allow-headers"), /x-request-id/i);
    assert.match(response.headers.get("access-control-expose-headers"), /x-request-id/i);
  });
});

test("missing CORS allowlist rejects browser origins and request IDs stay sanitized", async () => {
  const noOriginConfig = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  });

  await withHttpServer(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://any.example.test" },
    });
    assert.equal(denied.status, 403);

    const response = await fetch(`${baseUrl}/health`, {
      headers: { "X-Request-Id": "malformed id" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  }, createApp(noOriginConfig, { writeLog: () => {} }));
});

test("API rate limits return a consistent response while health remains available", async () => {
  const limitedEnvironment = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    CORS_ALLOWED_ORIGINS: "https://frontend.example.test",
    API_RATE_LIMIT_WINDOW_MS: "60000",
    API_RATE_LIMIT_MAX: "2",
  });
  const limitedApp = createApp(limitedEnvironment, { writeLog: () => {} });

  await withHttpServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/v1/one`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/v1/two`)).status, 404);

    const limited = await fetch(`${baseUrl}/api/v1/three`);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      success: false,
      message: "Too many requests. Please try again later.",
      data: null,
      error: { code: "RATE_LIMIT_EXCEEDED" },
      requestId: limited.headers.get("x-request-id"),
    });
  }, limitedApp);

  const strictEnvironment = validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    API_RATE_LIMIT_MAX: "1",
  });
  const strictApp = createApp(strictEnvironment, { writeLog: () => {}, checkDatabase: async () => { throw new Error("database probe unavailable"); } });

  await withHttpServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 503);
  }, strictApp);
});

test("unexpected production errors hide stack and sensitive message data", () => {
  const marker = "sensitive-token-marker-should-not-escape";
  const logged = [];
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log,
  };
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...args) => logged.push(args.join(" "));
  }

  const response = {
    headersSent: false,
    statusCode: undefined,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    errorHandler(new Error(`unexpected database credential ${marker}`), { requestId: "req-safe" }, response, () => {});
  } finally {
    for (const [method, original] of Object.entries(originalConsole)) {
      console[method] = original;
    }
  }

  assert.equal(response.statusCode, 500);
  assert.equal(response.payload.message, "An unexpected error occurred");
  assert.equal(response.payload.error.code, "INTERNAL_SERVER_ERROR");
  assert.equal(JSON.stringify(response.payload).includes(marker), false);
  assert.deepEqual(logged, []);
});

test("known application errors do not expose arbitrary error messages", () => {
  const marker = "credential-in-error-message";
  const response = {
    headersSent: false,
    statusCode: undefined,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  errorHandler(
    new ApiError(400, "UNMAPPED_APPLICATION_ERROR", marker),
    { requestId: "req-safe" },
    response,
    () => {},
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.message, "Request could not be processed");
  assert.equal(JSON.stringify(response.payload).includes(marker), false);
});

test("successful request logging emits one structured record with safe route metadata", async () => {
  const originalInfo = console.info;
  const outputLines = [];
  console.info = (line) => outputLines.push(line);

  try {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health?token=query-secret-marker`, {
        headers: { "X-Request-Id": "safe_request_014" },
      });
      assert.equal(response.status, 200);
    }, app);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(outputLines.length, 1);
  const record = JSON.parse(outputLines[0]);
  assert.deepEqual(Object.keys(record), [
    "timestamp",
    "level",
    "event",
    "requestId",
    "method",
    "route",
    "status",
    "durationMs",
  ]);
  assert.equal(record.requestId, "safe_request_014");
  assert.equal(record.method, "GET");
  assert.equal(record.route, "/health");
  assert.equal(record.status, 200);
  assert.equal(typeof record.durationMs, "number");
  assert.ok(record.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.equal(outputLines[0].includes("query-secret-marker"), false);
});

test("failed request logging excludes credentials, bodies and query strings", async () => {
  const originalInfo = console.info;
  const outputLines = [];
  const marker = "private-request-marker-014";
  console.info = (line) => outputLines.push(line);

  try {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/unknown?password=${marker}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${marker}`,
          Cookie: `session=${marker}`,
        },
        body: JSON.stringify({ password: marker, paymentSecret: marker }),
      });
      assert.equal(response.status, 404);
    }, app);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(outputLines.length, 1);
  const record = JSON.parse(outputLines[0]);
  assert.equal(record.level, "warn");
  assert.equal(record.status, 404);
  assert.equal(record.route, "unmatched");
  assert.equal(outputLines[0].includes(marker), false);
  assert.equal(outputLines[0].includes("password="), false);
});

test("request logging failures do not affect the HTTP response", async () => {
  const failureSafeApp = createApp(getEnv(), {
    writeLog() {
      throw new Error("logger output unavailable");
    },
  });

  await withHttpServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      message: "TrustBridge backend is running",
      data: { status: "healthy" },
    });
  }, failureSafeApp);
});
