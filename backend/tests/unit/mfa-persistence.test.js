import assert from "node:assert/strict";
import test from "node:test";
import { createMfaPersistenceService, MfaPersistenceError } from "../../src/services/mfa-persistence.service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const envelope = { ciphertext: Buffer.from("cipher"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "test", keyVersion: 1 };
const crypto = { async encrypt() { return envelope; }, async decrypt() { return "totp-secret"; } };
const activeUser = { status: "ACTIVE", role: "USER", authVersion: 0 };
const makeService = (client, extra = {}) => createMfaPersistenceService({ getClient: async () => client, encryption: crypto, now: () => new Date("2026-01-01T00:00:00Z"), makeId: () => "22222222-2222-4222-8222-222222222222", ...extra });
const transactionClient = (handlers) => ({
  $transaction: async (fn) => fn({ ...handlers }),
  ...handlers,
});

test("enrollment persists encrypted pending secret only and activation requires successful TOTP verification", async () => {
  let createArgs;
  let audits = 0;
  let verificationOptions;
  const client = transactionClient({
    user: { findUnique: async () => activeUser },
    userMfa: { create: async (args) => { createArgs = args; return { id: "mfa-id" }; }, findUnique: async () => createArgs ? ({ ...createArgs.data, id: "mfa-id" }) : null, updateMany: async () => ({ count: 1 }) },
    auditLog: { create: async () => { audits += 1; return { id: "audit" }; } },
  });
  const service = makeService(client, { totpWindowSteps: 2, verifyTotp: async (_secret, token, config) => { verificationOptions = config; return token === "123456" ? { valid: true, timeStep: 2_000_000 } : { valid: false }; } });
  const enrollment = await service.startEnrollment({ userId, secret: "private-totp-seed" });
  assert.equal(enrollment.enrollmentId, "mfa-id");
  assert.equal(createArgs.data.enrollmentStatus, "PENDING");
  assert.deepEqual(createArgs.data.pendingCiphertext, envelope.ciphertext);
  assert.equal(JSON.stringify(createArgs).includes("private-totp-seed"), false);
  await assert.rejects(service.activateEnrollment({ userId, token: "000000" }), MfaPersistenceError);
  assert.deepEqual(await service.activateEnrollment({ userId, token: "123456" }), { enabled: true });
  assert.deepEqual({ digits: verificationOptions.digits, stepSeconds: verificationOptions.stepSeconds, window: verificationOptions.window }, { digits: 6, stepSeconds: 30, window: 2 });
  assert.equal(audits, 2);
});

test("active or unexpired pending enrollment cannot be silently replaced", async () => {
  let record = { id: "mfa-id", enrollmentStatus: "ENABLED", enabledAt: new Date(), pendingExpiresAt: null };
  const client = transactionClient({
    user: { findUnique: async () => activeUser },
    userMfa: { findUnique: async () => record, updateMany: async () => ({ count: 0 }), create: async () => assert.fail("must not create duplicate MFA") },
    auditLog: { create: async () => ({ id: "audit" }) },
  });
  const service = makeService(client);
  await assert.rejects(service.startEnrollment({ userId, secret: "new-seed" }), (error) => error.code === "MFA_ALREADY_ENABLED");
  record = { id: "mfa-id", enrollmentStatus: "PENDING", enabledAt: null, pendingExpiresAt: new Date("2026-01-01T00:05:00Z") };
  await assert.rejects(service.startEnrollment({ userId, secret: "new-seed" }), (error) => error.code === "MFA_ENROLLMENT_PENDING");
});

test("activation and first recovery-code batch commit through one persistence transaction", async () => {
  let rows = [];
  let transactionCalls = 0;
  const client = {
    $transaction: async (fn) => {
      transactionCalls += 1;
      return fn({
        user: { findUnique: async () => activeUser },
        userMfa: {
          findUnique: async () => ({ id: "mfa", enrollmentStatus: "PENDING", pendingCiphertext: envelope.ciphertext, pendingNonce: envelope.nonce, pendingAuthTag: envelope.authTag, pendingKeyId: envelope.keyId, pendingKeyVersion: envelope.keyVersion, pendingExpiresAt: new Date("2026-01-01T00:10:00Z") }),
          updateMany: async () => ({ count: 1 }),
        },
        mfaRecoveryCode: { updateMany: async () => ({ count: 0 }), createMany: async ({ data }) => { rows = data; return { count: data.length }; } },
        auditLog: { create: async () => ({ id: "audit" }) },
      });
    },
  };
  const service = makeService(client, {
    verifyTotp: async () => ({ valid: true, timeStep: 500 }),
    makeRecoveryCode: (() => { let n = 0; return () => `CODE${String(++n).padStart(28, "0")}`; })(),
  });
  const result = await service.activateEnrollmentAndIssueRecoveryCodes({ userId, token: "123456" });
  assert.equal(transactionCalls, 1);
  assert.equal(result.enabled, true);
  assert.equal(result.codes.length, 10);
  assert.equal(rows.length, 10);
  assert.ok(rows.every((row) => !Object.hasOwn(row, "code")));
  assert.notEqual(rows[0].codeHash, result.codes[0]);
});

test("TOTP replay state advances through a single conditional update", async () => {
  const predicates = [];
  const client = transactionClient({ userMfa: { updateMany: async (args) => { predicates.push(args); return { count: predicates.length === 1 ? 1 : 0 }; } }, auditLog: { create: async () => ({ id: "audit" }) } });
  const service = makeService(client);
  assert.equal(await service.advanceTimeStep({ userId, timeStep: 100 }), true);
  assert.equal(await service.advanceTimeStep({ userId, timeStep: 100 }), false);
  assert.deepEqual(predicates[0].where.OR[1].lastAcceptedTimeStep, { lt: 100n });
});

test("step-up challenge stores only the token hash and binds session, resource, enrollment and expiry", async () => {
  let created;
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const enabledAt = new Date("2025-12-01T00:00:00Z");
  const mfaVerifiedAt = new Date("2026-01-01T00:00:00Z");
  const client = transactionClient({
    user: { findUnique: async () => ({ ...activeUser, authVersion: 3, mfa: { enrollmentStatus: "ENABLED", enabledAt, secretCiphertext: envelope.ciphertext } }) },
    refreshToken: { findUnique: async () => ({ id: sessionId, userId, authVersion: 3, mfaVerifiedAt, expiresAt: new Date("2026-01-02T00:00:00Z"), revokedAt: null }) },
    mfaChallenge: { create: async (args) => { created = args; return { id: "challenge-id" }; } },
  });
  const service = makeService(client, { makeChallenge: () => "opaque-step-up-token" });
  const token = await service.createStepUpChallenge({ userId, sessionId, authVersion: 3, mfaVerifiedAt, purpose: "TEST_ACTION", resourceType: "TRANSACTION", resourceId: "tx-1", allowedRoles: ["USER"], expiresAt: new Date("2026-01-01T00:05:00Z") });
  assert.equal(token, "opaque-step-up-token");
  assert.equal(created.data.sessionId, sessionId);
  assert.equal(created.data.resourceType, "TRANSACTION");
  assert.equal(created.data.resourceId, "tx-1");
  assert.equal(created.data.mfaEnabledAt, enabledAt);
  assert.equal(created.data.purpose, "STEP_UP");
  assert.equal(created.data.operationPurpose, "TEST_ACTION");
  assert.notEqual(created.data.tokenHash, token);
  assert.equal(created.data.tokenHash.length, 64);
});

test("step-up verification atomically claims one TOTP step and consumes one session/purpose/resource challenge", async () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const enabledAt = new Date("2025-12-01T00:00:00Z");
  const mfaVerifiedAt = new Date("2025-12-31T23:59:00Z");
  const challenge = {
    id: "challenge-id", userId, sessionId, purpose: "STEP_UP", operationPurpose: "TEST_ACTION", resourceType: "TRANSACTION", resourceId: "tx-1",
    mfaEnabledAt: enabledAt, authVersion: 3, attemptCount: 0, expiresAt: new Date("2026-01-01T00:05:00Z"), consumedAt: null, verifiedAt: null,
    user: { id: userId, role: "USER", status: "ACTIVE", authVersion: 3, mfa: { id: "mfa-id", enrollmentStatus: "ENABLED", enabledAt, secretCiphertext: envelope.ciphertext, secretNonce: envelope.nonce, secretAuthTag: envelope.authTag, secretKeyId: envelope.keyId, secretKeyVersion: envelope.keyVersion, lastAcceptedTimeStep: null } },
    session: { id: sessionId, userId, authVersion: 3, mfaVerifiedAt, expiresAt: new Date("2026-01-02T00:00:00Z"), revokedAt: null },
  };
  let lastStep = null;
  let attempts = 0;
  let consumed = false;
  const client = {
    $transaction: async (fn) => fn({
      mfaChallenge: {
        findUnique: async () => ({ ...challenge, attemptCount: attempts, consumedAt: consumed ? nowDate : null, verifiedAt: consumed ? nowDate : null }),
        updateMany: async ({ where, data }) => {
          if (data.attemptCount) { if (attempts !== where.attemptCount.equals || consumed) return { count: 0 }; attempts += 1; return { count: 1 }; }
          if (consumed || challenge.expiresAt <= new Date("2026-01-01T00:00:00Z")) return { count: 0 };
          consumed = true; return { count: 1 };
        },
      },
      userMfa: { updateMany: async ({ data }) => { const requested = data.lastAcceptedTimeStep; if (lastStep !== null && lastStep >= requested) return { count: 0 }; lastStep = requested; return { count: 1 }; } },
      auditLog: { create: async () => ({ id: "audit-id" }) },
    }),
  };
  const nowDate = new Date("2026-01-01T00:00:00Z");
  let verifyCalls = 0;
  const service = makeService(client, { verifyTotp: async () => { verifyCalls += 1; return { valid: true, timeStep: 50 }; } });
  const input = { token: "opaque", code: "123456", userId, sessionId, authVersion: 3, allowedPurposes: { TEST_ACTION: { allowedRoles: ["USER"], resourceType: "TRANSACTION", resourceRequired: true } } };
  const results = await Promise.all([service.completeStepUpChallenge(input), service.completeStepUpChallenge(input)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).purpose, "TEST_ACTION");
  assert.equal(results.find(Boolean).resourceId, "tx-1");
  assert.equal(lastStep, 50n);
  assert.equal(consumed, true);
  assert.equal(verifyCalls, 2);
  assert.ok(attempts <= 1);
  assert.equal(await service.completeStepUpChallenge(input), null);
});

test("step-up challenge denies wrong account/session, changed MFA, revoked session, expiry and wrong purpose", async () => {
  const base = {
    id: "challenge-id", userId, sessionId: "33333333-3333-4333-8333-333333333333", purpose: "STEP_UP", operationPurpose: "TEST_ACTION", resourceType: "USER", resourceId: userId,
    mfaEnabledAt: new Date("2025-12-01T00:00:00Z"), authVersion: 0, attemptCount: 0, expiresAt: new Date("2026-01-01T00:05:00Z"), consumedAt: null, verifiedAt: null,
    user: { id: userId, role: "USER", status: "ACTIVE", authVersion: 0, mfa: { id: "mfa", enrollmentStatus: "ENABLED", enabledAt: new Date("2025-12-01T00:00:00Z"), secretCiphertext: envelope.ciphertext } },
    session: { id: "33333333-3333-4333-8333-333333333333", userId, authVersion: 0, mfaVerifiedAt: new Date("2025-12-31T23:59:00Z"), expiresAt: new Date("2026-01-02T00:00:00Z"), revokedAt: null },
  };
  for (const challenge of [
    { ...base, sessionId: "44444444-4444-4444-8444-444444444444" },
    { ...base, userId: "44444444-4444-4444-8444-444444444444" },
    { ...base, purpose: "LOGIN" },
    { ...base, expiresAt: new Date("2025-12-31T23:59:59Z") },
    { ...base, consumedAt: new Date() },
    { ...base, session: { ...base.session, revokedAt: new Date() } },
    { ...base, mfaEnabledAt: new Date("2025-12-02T00:00:00Z") },
    { ...base, attemptCount: 5 },
    { ...base, user: { ...base.user, status: "SUSPENDED" } },
    { ...base, user: { ...base.user, authVersion: 1 } },
    { ...base, user: { ...base.user, role: "ADMIN" } },
  ]) {
    const client = transactionClient({ mfaChallenge: { findUnique: async () => challenge } });
    const service = makeService(client, { verifyTotp: async () => assert.fail("must not verify an invalid challenge") });
    assert.equal(await service.completeStepUpChallenge({ token: "opaque", code: "123456", userId, sessionId: challenge.sessionId, authVersion: 0, allowedPurposes: { TEST_ACTION: { allowedRoles: ["USER"], resourceType: "USER", resourceRequired: true } } }), null);
  }
});

test("concurrent TOTP replay updates allow only one request to claim a step", async () => {
  let claimed = false;
  const client = transactionClient({ userMfa: { updateMany: async () => {
    if (claimed) return { count: 0 };
    claimed = true;
    return { count: 1 };
  } }, auditLog: { create: async () => ({ id: "audit" }) } });
  const service = makeService(client);
  const results = await Promise.all([
    service.advanceTimeStep({ userId, timeStep: 101 }),
    service.advanceTimeStep({ userId, timeStep: 101 }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("concurrent enrollment verification issues exactly one recovery batch", async () => {
  let claimed = false;
  let batches = 0;
  const client = {
    $transaction: async (fn) => fn({
      user: { findUnique: async () => activeUser },
      userMfa: {
        findUnique: async () => ({ id: "mfa", enrollmentStatus: "PENDING", pendingCiphertext: envelope.ciphertext, pendingNonce: envelope.nonce, pendingAuthTag: envelope.authTag, pendingKeyId: envelope.keyId, pendingKeyVersion: envelope.keyVersion, pendingExpiresAt: new Date("2026-01-01T00:10:00Z") }),
        updateMany: async () => {
          if (claimed) return { count: 0 };
          claimed = true;
          return { count: 1 };
        },
      },
      mfaRecoveryCode: { updateMany: async () => ({ count: 0 }), createMany: async ({ data }) => { batches += 1; return { count: data.length }; } },
      auditLog: { create: async () => ({ id: "audit" }) },
    }),
  };
  const service = makeService(client, { verifyTotp: async () => ({ valid: true, timeStep: 501 }) });
  const results = await Promise.allSettled([
    service.activateEnrollmentAndIssueRecoveryCodes({ userId, token: "123456" }),
    service.activateEnrollmentAndIssueRecoveryCodes({ userId, token: "123456" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(batches, 1);
});

test("recovery batch persists only hashes, invalidates old codes, and consumes once", async () => {
  let rows;
  let consumed = false;
  let invalidated = 0;
  const handlers = {
    user: { findUnique: async () => activeUser },
    userMfa: { findUnique: async () => ({ enabledAt: new Date() }) },
    mfaRecoveryCode: {
      updateMany: async (args) => { if (args.data.invalidatedAt) invalidated += 1; else if (!consumed && args.where.codeHash === rows[0].codeHash) { consumed = true; return { count: 1 }; } return { count: 0 }; },
      createMany: async ({ data }) => { rows = data; return { count: data.length }; },
    },
    auditLog: { create: async () => ({ id: "audit" }) },
  };
  const service = makeService(transactionClient(handlers), { makeRecoveryCode: (() => { let n = 0; return () => `RECOVERYCODE${String(++n).padStart(20, "0")}`; })() });
  const batch = await service.createRecoveryCodeBatch({ userId });
  assert.equal(batch.codes.length, 10);
  assert.equal(rows.length, 10);
  assert.equal(invalidated, 1);
  assert.ok(rows.every((row) => !Object.hasOwn(row, "code")));
  assert.notEqual(rows[0].codeHash, batch.codes[0]);
  const simultaneous = await Promise.all([
    service.consumeRecoveryCode({ userId, code: batch.codes[0] }),
    service.consumeRecoveryCode({ userId, code: batch.codes[0] }),
  ]);
  assert.deepEqual(simultaneous.sort(), [false, true]);
});

test("failed recovery batch transaction rolls back invalidation and inserts", async () => {
  const state = { existingInvalidated: false, rows: [] };
  const client = {
    $transaction: async (fn) => {
      const snapshot = structuredClone(state);
      try { return await fn({
        user: { findUnique: async () => activeUser },
        userMfa: { findUnique: async () => ({ enabledAt: new Date() }) },
        mfaRecoveryCode: {
          updateMany: async () => { state.existingInvalidated = true; return { count: 1 }; },
          createMany: async ({ data }) => { state.rows.push(...data); return { count: data.length }; },
        },
        auditLog: { create: async () => { throw new Error("audit storage failed"); } },
      }); } catch (error) { Object.assign(state, snapshot); throw error; }
    },
  };
  const service = makeService(client);
  await assert.rejects(service.createRecoveryCodeBatch({ userId }), MfaPersistenceError);
  assert.deepEqual(state, { existingInvalidated: false, rows: [] });
});

test("challenge state is hashed, bounded, and consumed conditionally", async () => {
  let create;
  let attempts = 0;
  let consumed = 0;
  const challenge = { id: "challenge-id", purpose: "LOGIN", authVersion: 0, attemptCount: 0, expiresAt: new Date("2026-01-01T00:05:00Z"), consumedAt: null, user: { status: "ACTIVE", authVersion: 0 } };
  const client = transactionClient({
    user: { findUnique: async () => ({ ...activeUser, mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } }) },
    mfaChallenge: {
      create: async (args) => { create = args; return { id: "c" }; },
      findUnique: async () => challenge,
      updateMany: async (args) => { if (args.data.attemptCount) { attempts++; challenge.attemptCount++; } if (args.data.consumedAt) { consumed++; challenge.consumedAt = args.data.consumedAt; } return { count: 1 }; },
    },
  });
  const service = makeService(client, { makeChallenge: () => "opaque-token-not-stored" });
  const expiry = new Date("2026-01-01T00:05:00Z");
  const token = await service.createChallenge({ userId, purpose: "LOGIN", expiresAt: expiry });
  assert.equal(token, "opaque-token-not-stored");
  assert.notEqual(create.data.tokenHash, token);
  assert.equal(await service.recordChallengeFailure({ token }), true);
  assert.equal(await service.consumeChallenge({ token, purpose: "LOGIN" }), true);
  assert.equal(attempts, 1);
  assert.equal(consumed, 1);
});

test("login challenge atomically consumes one challenge and one TOTP step, with bounded failed attempts", async () => {
  const state = {
    attemptCount: 0, consumedAt: null, lastAcceptedTimeStep: 40n,
    expiresAt: new Date("2026-01-01T00:05:00Z"),
  };
  const account = { id: userId, role: "USER", status: "ACTIVE", authVersion: 3 };
  let lock = Promise.resolve();
  const client = {
    $transaction: async (fn) => {
      let release;
      const previous = lock;
      lock = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await fn({
          user: { findUnique: async () => ({ ...account, mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } }) },
          mfaChallenge: {
            findUnique: async () => ({ id: "challenge", purpose: "LOGIN", authVersion: 3, attemptCount: state.attemptCount, expiresAt: state.expiresAt, consumedAt: state.consumedAt, user: { ...account, mfa: { id: "mfa", enrollmentStatus: "ENABLED", enabledAt: new Date(), secretCiphertext: envelope.ciphertext, secretNonce: envelope.nonce, secretAuthTag: envelope.authTag, secretKeyId: envelope.keyId, secretKeyVersion: envelope.keyVersion, lastAcceptedTimeStep: state.lastAcceptedTimeStep } } }),
            updateMany: async ({ where, data }) => {
              if (where.consumedAt === null && where.attemptCount?.equals === state.attemptCount && state.consumedAt === null && state.expiresAt > new Date("2026-01-01T00:00:00Z") && data.attemptCount?.increment === 1) { state.attemptCount += 1; return { count: 1 }; }
              if (where.consumedAt === null && where.attemptCount?.equals === state.attemptCount && state.consumedAt === null && state.expiresAt > new Date("2026-01-01T00:00:00Z") && data.consumedAt) { state.consumedAt = data.consumedAt; return { count: 1 }; }
              return { count: 0 };
            },
          },
          userMfa: { updateMany: async ({ where, data }) => {
            const step = BigInt(data.lastAcceptedTimeStep);
            if (state.lastAcceptedTimeStep === null || state.lastAcceptedTimeStep < step) { state.lastAcceptedTimeStep = step; return { count: 1 }; }
            return { count: 0 };
          } },
          auditLog: { create: async () => ({ id: "audit" }) },
        });
      } finally { release(); }
    },
  };
  const service = makeService(client, { verifyTotp: async (_secret, code) => code === "123456" ? { valid: true, timeStep: 41 } : { valid: false } });
  const outcomes = await Promise.all([
    service.completeLoginChallenge({ token: "opaque-login-challenge", code: "123456" }),
    service.completeLoginChallenge({ token: "opaque-login-challenge", code: "123456" }),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(state.lastAcceptedTimeStep, 41n);
  assert.ok(state.consumedAt instanceof Date);

  state.consumedAt = null;
  state.lastAcceptedTimeStep = 41n;
  const replay = await service.completeLoginChallenge({ token: "opaque-login-challenge", code: "123456" });
  assert.equal(replay, null);
  assert.equal(state.attemptCount, 1);
});

test("failed, expired, consumed, wrong-purpose and exhausted login challenges cannot issue a session", async () => {
  for (const overrides of [
    { expiresAt: new Date("2025-12-31T23:59:59Z") },
    { consumedAt: new Date("2025-12-31T23:59:59Z") },
    { purpose: "STEP_UP" },
    { attemptCount: 5 },
    { user: { id: userId, role: "USER", status: "DEACTIVATED", authVersion: 0, mfa: { id: "mfa", enrollmentStatus: "ENABLED", enabledAt: new Date(), secretCiphertext: envelope.ciphertext, secretNonce: envelope.nonce, secretAuthTag: envelope.authTag, secretKeyId: envelope.keyId, secretKeyVersion: envelope.keyVersion, lastAcceptedTimeStep: 1n } } },
    { user: { id: userId, role: "USER", status: "ACTIVE", authVersion: 1, mfa: { id: "mfa", enrollmentStatus: "ENABLED", enabledAt: new Date(), secretCiphertext: envelope.ciphertext, secretNonce: envelope.nonce, secretAuthTag: envelope.authTag, secretKeyId: envelope.keyId, secretKeyVersion: envelope.keyVersion, lastAcceptedTimeStep: 1n } } },
    { user: { id: userId, role: "ADMIN", status: "ACTIVE", authVersion: 0, mfa: { id: "mfa", enrollmentStatus: "DISABLED", enabledAt: null, secretCiphertext: null } } },
  ]) {
    const challenge = { id: "c", purpose: "LOGIN", authVersion: 0, attemptCount: 0, expiresAt: new Date("2026-01-01T00:05:00Z"), consumedAt: null, user: { id: userId, role: "USER", status: "ACTIVE", authVersion: 0, mfa: { id: "mfa", enrollmentStatus: "ENABLED", enabledAt: new Date(), secretCiphertext: envelope.ciphertext, secretNonce: envelope.nonce, secretAuthTag: envelope.authTag, secretKeyId: envelope.keyId, secretKeyVersion: envelope.keyVersion, lastAcceptedTimeStep: 1n } }, ...overrides };
    const service = makeService(transactionClient({ mfaChallenge: { findUnique: async () => challenge, updateMany: async () => ({ count: 1 }) } }), { verifyTotp: async () => ({ valid: false }) });
    assert.equal(await service.completeLoginChallenge({ token: "opaque", code: "000000" }), null);
  }
});

test("challenge failure and consumption reject stale account authorization versions", async () => {
  const client = transactionClient({ mfaChallenge: {
    findUnique: async () => ({ id: "challenge", purpose: "LOGIN", authVersion: 0, attemptCount: 0, expiresAt: new Date("2026-01-01T00:05:00Z"), consumedAt: null, user: { status: "ACTIVE", authVersion: 1 } }),
    updateMany: async () => { throw new Error("must not claim stale challenge"); },
  } });
  const service = makeService(client);
  assert.equal(await service.recordChallengeFailure({ token: "opaque" }), false);
  assert.equal(await service.consumeChallenge({ token: "opaque", purpose: "LOGIN" }), false);
});

test("recovery requires external identity verification, two distinct active admins, and rejects self-approval", async () => {
  const request = { id: "r", userId, status: "PENDING", identityVerifiedAt: new Date(), expiresAt: new Date("2026-02-01"), version: 1 };
  const approvals = [];
  const client = {
    $transaction: async (fn) => fn({
      user: { findUnique: async ({ where }) => where.id === "admin-1" || where.id === "admin-2" ? { id: where.id, role: "ADMIN", status: "ACTIVE" } : activeUser },
      accountRecoveryRequest: { findUnique: async () => request, updateMany: async ({ data }) => { request.status = data.status; request.version++; return { count: 1 }; } },
      recoveryApproval: { create: async ({ data }) => { approvals.push(data); return { id: `a${approvals.length}` }; }, count: async () => approvals.filter((a) => a.decision === "APPROVE").length },
      auditLog: { create: async () => ({ id: "audit" }) },
    }),
  };
  const service = makeService(client, { verifyIndependentIdentity: async ({ evidenceReference }) => evidenceReference === "verification-ref" });
  await assert.rejects(service.verifyRecoveryIdentity({ requestId: "r", evidenceReference: "ref" }), MfaPersistenceError);
  await assert.rejects(service.recordRecoveryApproval({ requestId: "r", approverId: userId, decision: "APPROVE" }), MfaPersistenceError);
  request.status = "PENDING";
  assert.deepEqual(await service.recordRecoveryApproval({ requestId: "r", approverId: "admin-1", decision: "APPROVE" }), { status: "PENDING" });
  request.status = "PENDING";
  assert.deepEqual(await service.recordRecoveryApproval({ requestId: "r", approverId: "admin-2", decision: "APPROVE" }), { status: "APPROVED" });
  assert.equal(approvals.length, 2);
});
