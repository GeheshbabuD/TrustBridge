
import assert from "node:assert/strict";
import test from "node:test";
import { createStepUpAuthorizationMiddleware } from "../../src/middleware/recentMfa.middleware.js";
import { createStepUpPurposeRegistry } from "../../src/services/step-up-purpose.registry.js";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";

const now = new Date("2026-01-01T00:05:00Z");
const enabledAt = new Date("2025-12-01T00:00:00Z");
const verifiedAt = new Date("2026-01-01T00:04:00Z");

const auth = {
  userId,
  sessionId,
  authVersion: 2,
  role: "USER",
  mfaEnabled: true,
  assuranceLevel: "TOTP_VERIFIED",
  mfaVerifiedAt: verifiedAt,
};

const registry = createStepUpPurposeRegistry({
  TEST_ACTION: {
    resourceType: "TRANSACTION",
    resourceRequired: true,
    allowedRoles: ["USER"],
    maxAgeSeconds: 300,
    additionalAuthorizationRequired: true,
    oneTime: true,
  },
});

const invoke = async (middleware, request) =>
  new Promise((resolve) => {
    middleware(request, {}, (error) => resolve(error));
  });

const makeChallenge = () => ({
  id: "grant-1",
  userId,
  sessionId,
  purpose: "STEP_UP",
  operationPurpose: "TEST_ACTION",
  resourceType: "TRANSACTION",
  resourceId,
  authVersion: 2,
  mfaEnabledAt: enabledAt,
  verifiedAt,
  expiresAt: new Date("2026-01-01T00:10:00Z"),
  consumedAt: verifiedAt,
  grantConsumedAt: null,
});

const makeTransactionalStore = ({
  activeEnabledAt = enabledAt,
} = {}) => {
  const challenge = makeChallenge();

  const calls = {
    transaction: 0,
    lock: 0,
    findFirst: [],
    updateMany: [],
  };

  const matchesChallenge = (where) =>
    challenge.grantConsumedAt === null &&
    challenge.userId === where.userId &&
    challenge.sessionId === where.sessionId &&
    challenge.purpose === where.purpose &&
    challenge.operationPurpose === where.operationPurpose &&
    challenge.resourceType === where.resourceType &&
    challenge.resourceId === where.resourceId &&
    challenge.authVersion === where.authVersion &&
    where.mfaEnabledAt instanceof Date &&
    challenge.mfaEnabledAt.getTime() === where.mfaEnabledAt.getTime();

  const tx = {
    $queryRaw: async () => {
      calls.lock += 1;

      return [{
        id: "mfa-1",
        userId,
        enrollmentStatus: "ENABLED",
        enabledAt: activeEnabledAt,
      }];
    },

    mfaChallenge: {
      findFirst: async ({ where }) => {
        calls.findFirst.push({ where });

        return matchesChallenge(where)
          ? { ...challenge }
          : null;
      },

      updateMany: async ({ where, data }) => {
        calls.updateMany.push({ where, data });

        if (
          challenge.id !== where.id ||
          where.grantConsumedAt !== null ||
          !matchesChallenge(where)
        ) {
          return { count: 0 };
        }

        Object.assign(challenge, data);
        return { count: 1 };
      },
    },
  };

  const client = {
    $transaction: async (callback) => {
      calls.transaction += 1;
      return callback(tx);
    },
  };

  return { client, challenge, calls };
};

const validRequest = () => ({
  auth,
  params: { id: resourceId },
  headers: {},
});

const createMiddleware = (client) =>
  createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => client,
  });

test("one-time step-up grant is locked, selected and consumed transactionally", async () => {
  const store = makeTransactionalStore();
  const middleware = createMiddleware(store.client);

  const error = await invoke(middleware, validRequest());

  assert.equal(error, undefined);
  assert.equal(store.calls.transaction, 1);
  assert.equal(store.calls.lock, 1);
  assert.equal(store.calls.findFirst.length, 1);
  assert.equal(store.calls.updateMany.length, 1);

  const selected = store.calls.findFirst[0].where;

  assert.equal(selected.userId, userId);
  assert.equal(selected.sessionId, sessionId);
  assert.equal(selected.resourceId, resourceId);
  assert.equal(selected.purpose, "STEP_UP");
  assert.equal(selected.operationPurpose, "TEST_ACTION");

  const update = store.calls.updateMany[0];

  assert.equal(update.where.id, "grant-1");
  assert.equal(update.where.grantConsumedAt, null);
  assert.deepEqual(Object.keys(update.data), ["grantConsumedAt"]);

  assert.ok(store.challenge.grantConsumedAt instanceof Date);
  assert.equal(
    store.challenge.consumedAt.getTime(),
    verifiedAt.getTime()
  );
});

test("one-time step-up grant cannot be replayed", async () => {
  const store = makeTransactionalStore();
  const middleware = createMiddleware(store.client);

  const first = await invoke(middleware, validRequest());
  assert.equal(first, undefined);

  const second = await invoke(middleware, validRequest());

  assert.equal(second.code, "MFA_ASSURANCE_REQUIRED");
  assert.equal(store.calls.transaction, 2);
  assert.equal(store.calls.updateMany.length, 1);
  assert.equal(
    store.challenge.consumedAt.getTime(),
    verifiedAt.getTime()
  );
});

test("step-up grant is invalidated when MFA enrollment has been replaced", async () => {
  const newEnabledAt = new Date("2025-12-02T00:00:00Z");
  const store = makeTransactionalStore({
    activeEnabledAt: newEnabledAt,
  });

  const middleware = createMiddleware(store.client);
  const error = await invoke(middleware, validRequest());

  assert.equal(error.code, "MFA_ASSURANCE_REQUIRED");
  assert.equal(store.calls.lock, 1);
  assert.equal(store.calls.findFirst.length, 1);
  assert.equal(store.calls.updateMany.length, 0);
  assert.equal(store.challenge.grantConsumedAt, null);
});

test("transaction and database errors fail closed", async () => {
  const client = {
    $transaction: async () => {
      throw new Error("private database detail");
    },
  };

  const middleware = createMiddleware(client);
  const error = await invoke(middleware, validRequest());

  assert.equal(error.code, "MFA_STEP_UP_UNAVAILABLE");
  assert.doesNotMatch(error.message, /private database detail/);
});

test("wrong role, missing authentication and invalid resource are denied", async () => {
  const store = makeTransactionalStore();
  const middleware = createMiddleware(store.client);

  const requests = [
    {
      auth: null,
      params: { id: resourceId },
      headers: {},
    },
    {
      ...validRequest(),
      auth: { ...auth, role: "ADMIN" },
    },
    {
      ...validRequest(),
      params: {
        id: "44444444-4444-4444-8444-444444444444",
      },
    },
    {
      ...validRequest(),
      params: {},
    },
  ];

  for (const request of requests) {
    const error = await invoke(middleware, request);

    assert.equal(error?.code, "MFA_ASSURANCE_REQUIRED");
  }
});
