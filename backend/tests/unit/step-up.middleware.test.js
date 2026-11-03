
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStepUpAuthorizationMiddleware,
} from "../../src/middleware/recentMfa.middleware.js";

import {
  createStepUpPurposeRegistry,
} from "../../src/services/step-up-purpose.registry.js";

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
  mfaVerifiedAt: new Date("2026-01-01T00:00:00Z"),
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

const validRequest = () => ({
  auth,
  params: { id: resourceId },
  headers: {},
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
  challenge = makeChallenge(),
} = {}) => {
  const calls = {
    transaction: 0,
    lock: 0,
    findFirst: [],
    updateMany: [],
  };

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
      findFirst: async (args) => {
        calls.findFirst.push(args);

        if (!challenge || challenge.grantConsumedAt !== null) {
          return null;
        }

        // Simulate the database enrollment timestamp filter.
        if (
          args.where.mfaEnabledAt.getTime() !==
          activeEnabledAt.getTime()
        ) {
          return null;
        }

        if (
          challenge.mfaEnabledAt.getTime() !==
          activeEnabledAt.getTime()
        ) {
          return null;
        }

        return { id: challenge.id };
      },

      updateMany: async ({ where, data }) => {
        calls.updateMany.push({ where, data });

        if (
          !challenge ||
          where.id !== challenge.id ||
          where.grantConsumedAt !== null ||
          challenge.grantConsumedAt !== null ||
          where.mfaEnabledAt.getTime() !== activeEnabledAt.getTime() ||
          challenge.mfaEnabledAt.getTime() !== activeEnabledAt.getTime()
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

test("one-time step-up grant is locked, selected and consumed transactionally", async () => {
  const store = makeTransactionalStore();

  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => store.client,
  });

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
  assert.equal(selected.mfaEnabledAt.getTime(), enabledAt.getTime());

  const update = store.calls.updateMany[0];

  assert.equal(update.where.id, "grant-1");
  assert.equal(update.where.grantConsumedAt, null);
  assert.deepEqual(Object.keys(update.data), ["grantConsumedAt"]);

  assert.ok(store.challenge.grantConsumedAt instanceof Date);

  // Grant consumption must not overwrite TOTP challenge consumption.
  assert.equal(
    store.challenge.consumedAt.getTime(),
    verifiedAt.getTime()
  );
});

test("one-time step-up grant cannot be replayed", async () => {
  const store = makeTransactionalStore();

  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => store.client,
  });

  const first = await invoke(middleware, validRequest());

  assert.equal(first, undefined);

  const second = await invoke(middleware, validRequest());

  assert.ok(second);
  assert.equal(second.code, "MFA_ASSURANCE_REQUIRED");

  assert.equal(store.calls.transaction, 2);
  assert.equal(store.calls.updateMany.length, 1);

  assert.equal(
    store.challenge.consumedAt.getTime(),
    verifiedAt.getTime()
  );
});

test("step-up grant is invalidated when MFA enrollment has been replaced", async () => {
  const oldEnabledAt = new Date("2025-12-01T00:00:00Z");
  const newEnabledAt = new Date("2025-12-02T00:00:00Z");

  const oldChallenge = {
    ...makeChallenge(),
    mfaEnabledAt: oldEnabledAt,
  };

  const store = makeTransactionalStore({
    activeEnabledAt: newEnabledAt,
    challenge: oldChallenge,
  });

  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => store.client,
  });

  const error = await invoke(middleware, validRequest());

  assert.ok(error);
  assert.equal(error.code, "MFA_ASSURANCE_REQUIRED");

  // The old enrollment grant must never be consumed.
  assert.equal(store.calls.updateMany.length, 0);
  assert.equal(oldChallenge.grantConsumedAt, null);
});

test("transaction and database errors fail closed", async () => {
  const client = {
    $transaction: async () => {
      throw new Error("private database detail");
    },
  };

  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => client,
  });

  const error = await invoke(middleware, validRequest());

  assert.ok(error);
  assert.equal(error.code, "MFA_STEP_UP_UNAVAILABLE");
  assert.doesNotMatch(error.message, /private database detail/);
});

test("wrong role, missing authentication and invalid resource are denied", async () => {
  const store = makeTransactionalStore({
    challenge: null,
  });

  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => store.client,
  });

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

    assert.ok(error);
    assert.equal(error.code, "MFA_ASSURANCE_REQUIRED");
  }
});

test("stale assurance and unregistered purposes are rejected", async () => {
  const store = makeTransactionalStore({
    challenge: null,
  });

  const staleMiddleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    maxAgeSeconds: 60,
    getClient: async () => store.client,
  });

  const staleError = await invoke(
    staleMiddleware,
    validRequest()
  );

  assert.ok(staleError);
  assert.equal(staleError.code, "MFA_ASSURANCE_REQUIRED");

  assert.throws(
    () =>
      createStepUpAuthorizationMiddleware({
        purpose: "NOT_REGISTERED",
        purposeRegistry: registry,
      }),
    /registered step-up purpose/
  );
});

test("storage failures fail closed without exposing database details", async () => {
  const middleware = createStepUpAuthorizationMiddleware({
    purpose: "TEST_ACTION",
    purposeRegistry: registry,
    now: () => now,
    getClient: async () => {
      throw new Error("private DB detail");
    },
  });

  const error = await invoke(middleware, validRequest());

  assert.ok(error);
  assert.equal(error.code, "MFA_STEP_UP_UNAVAILABLE");
  assert.doesNotMatch(error.message, /private DB detail/);
});
