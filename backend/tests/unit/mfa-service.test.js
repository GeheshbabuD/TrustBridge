import assert from "node:assert/strict";
import test from "node:test";
import { createMfaService, MfaServiceError } from "../../src/services/mfa.service.js";
import { MfaPersistenceError } from "../../src/services/mfa-persistence.service.js";
import { createLocalDevelopmentEncryptionProvider, MfaCryptoError } from "../../src/services/mfa-crypto.service.js";

const environment = { nodeEnv: "test", mfa: { totpWindowSteps: 1, loginChallengeTtlSeconds: 300, assuranceMaxAgeSeconds: 900 } };
const user = { id: "u-1", email: "admin@example.test", role: "ADMIN", status: "ACTIVE", mfa: null };
const client = (recoveryCount = 0) => ({ user: { findUnique: async () => user }, mfaRecoveryCode: { count: async () => recoveryCount } });

test("production MFA service fails closed without a KMS provider and rejects the local adapter", () => {
  const prod = { nodeEnv: "production", mfa: { encryptionProvider: "kms", kmsKeyId: "key", kmsKeyVersion: 1, totpWindowSteps: 1 } };
  assert.throws(() => createMfaService({ environment: prod }), MfaCryptoError);
  const local = createLocalDevelopmentEncryptionProvider({ environment: () => ({ nodeEnv: "test", mfa: { localEncryptionKey: Buffer.alloc(32, 1) } }) });
  assert.throws(() => createMfaService({ environment: prod, encryptionProvider: local }), MfaCryptoError);
});

test("MFA service exposes KMS availability as a safe fail-closed check", async () => {
  const unavailable = createMfaService({ environment, encryptionProvider: {
    kind: "kms-envelope", async encryptSecret() {}, async decryptSecret() {}, async checkAvailability() { throw new Error("sensitive provider detail"); },
  }, persistence: {} });
  await assert.rejects(unavailable.checkEncryptionAvailability(), (error) => error instanceof MfaServiceError && error.statusCode === 503 && !error.message.includes("sensitive"));
});

test("enrollment persists through the 034B interface and returns a normalized authenticator URI once", async () => {
  let persisted;
  const service = createMfaService({
    environment,
    getClient: async () => client(),
    createSecret: () => "JBSWY3DPEHPK3PXP",
    persistence: { startEnrollment: async (input) => { persisted = input; return { enrollmentId: "enroll-1", expiresAt: new Date("2026-01-01T00:10:00Z") }; } },
  });
  const result = await service.startEnrollment({ userId: "u-1", requestId: "req-1" });
  assert.equal(persisted.userId, "u-1");
  assert.equal(persisted.secret, "JBSWY3DPEHPK3PXP");
  assert.match(result.provisioningUri, /^otpauth:\/\/totp\/TrustBridge:admin%40example\.test\?/);
  assert.match(result.provisioningUri, /algorithm=SHA1/);
  assert.match(result.provisioningUri, /digits=6/);
  assert.match(result.provisioningUri, /period=30/);
  assert.equal(result.secret, "JBSWY3DPEHPK3PXP");
});

test("enrollment fails closed when encryption is unavailable without returning the secret", async () => {
  const service = createMfaService({
    environment,
    getClient: async () => client(),
    createSecret: () => "private-seed-marker",
    persistence: { startEnrollment: async () => { throw new MfaCryptoError(); } },
  });
  await assert.rejects(service.startEnrollment({ userId: "u-1" }), (error) => error instanceof MfaServiceError && error.statusCode === 503 && !error.message.includes("private-seed-marker"));
});

test("verification exposes recovery codes only when atomic activation and issuance succeed", async () => {
  const recoveryCodes = Object.freeze(["one-time-code"]);
  const service = createMfaService({ environment, persistence: {
    activateEnrollmentAndIssueRecoveryCodes: async ({ userId, token }) => { assert.equal(userId, "u-1"); assert.equal(token, "123456"); return { enabled: true, codes: recoveryCodes }; },
  } });
  assert.deepEqual(await service.verifyEnrollment({ userId: "u-1", code: "123456" }), { enabled: true, recoveryCodes });

  const failed = createMfaService({ environment, persistence: { activateEnrollmentAndIssueRecoveryCodes: async () => { throw new MfaPersistenceError("MFA_VERIFICATION_FAILED"); } } });
  await assert.rejects(failed.verifyEnrollment({ userId: "u-1", code: "000000" }), (error) => error.code === "MFA_VERIFICATION_FAILED");
});

test("MFA status exposes only policy and lifecycle metadata for user and admin roles", async () => {
  for (const [role, required] of [["USER", false], ["ADMIN", true]]) {
    const account = { ...user, role, mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date(), pendingExpiresAt: null } };
    const service = createMfaService({ environment, getClient: async () => ({ user: { findUnique: async () => account }, mfaRecoveryCode: { count: async () => 7 } }), persistence: {} });
    const status = await service.getStatus({ userId: "u-1" });
    assert.deepEqual(status, { enabled: true, enrollmentPending: false, requiredByPolicy: required, unusedRecoveryCodes: 7 });
    assert.doesNotMatch(JSON.stringify(status), /secret|hash|cipher|keyId|challenge/i);
  }
});

test("legacy ADMIN inventory lists only active accounts without enabled MFA and exposes no secret metadata", async () => {
  const service = createMfaService({ environment, persistence: {}, getClient: async () => ({ user: { findMany: async () => [
    { id: "admin-enabled", email: "enabled@example.invalid", mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } },
    { id: "admin-disabled", email: "disabled@example.invalid", mfa: { enrollmentStatus: "DISABLED", enabledAt: null, secretCiphertext: Buffer.from("hidden") } },
    { id: "admin-missing", email: "missing@example.invalid", mfa: null },
  ] } }) });
  assert.deepEqual(await service.listLegacyAdminAccounts(), [
    { id: "admin-disabled", email: "disabled@example.invalid" },
    { id: "admin-missing", email: "missing@example.invalid" },
  ]);
});

test("status treats stale enrollment as not pending and inactive accounts are denied", async () => {
  const staleUser = { ...user, mfa: { enrollmentStatus: "PENDING", enabledAt: null, pendingExpiresAt: new Date("2025-12-31T23:59:59Z") } };
  const service = createMfaService({ environment, now: () => new Date("2026-01-01T00:00:00Z"), getClient: async () => ({ user: { findUnique: async () => staleUser }, mfaRecoveryCode: { count: async () => 0 } }), persistence: {} });
  assert.deepEqual(await service.getStatus({ userId: "u-1" }), { enabled: false, enrollmentPending: false, requiredByPolicy: true, unusedRecoveryCodes: 0 });
  await assert.rejects(createMfaService({ environment, getClient: async () => ({ user: { findUnique: async () => ({ ...user, status: "DEACTIVATED" }) } }), persistence: {} }).startEnrollment({ userId: "u-1" }), (error) => error.code === "AUTHENTICATION_REQUIRED");
});

test("login challenge lifetime is short, purpose-bound and opaque", async () => {
  let input;
  const now = new Date("2026-01-01T00:00:00Z");
  const service = createMfaService({ environment, now: () => now, persistence: {
    createChallenge: async (value) => { input = value; return "opaque-challenge-token"; },
  } });
  const result = await service.createLoginChallenge({ userId: "u-1", authVersion: 4 });
  assert.deepEqual(input, { userId: "u-1", purpose: "LOGIN", authVersion: 4, expiresAt: new Date("2026-01-01T00:05:00Z") });
  assert.deepEqual(result, { challengeToken: "opaque-challenge-token", expiresAt: new Date("2026-01-01T00:05:00Z") });
});

test("login challenge verification returns only the persistence-verified identity context", async () => {
  const mfaVerifiedAt = new Date("2026-01-01T00:00:00Z");
  const service = createMfaService({ environment, persistence: {
    completeLoginChallenge: async ({ token, code }) => {
      assert.equal(token, "opaque-challenge"); assert.equal(code, "123456");
      return { userId: "u-1", role: "ADMIN", authVersion: 9, mfaVerifiedAt, assuranceLevel: "TOTP_VERIFIED" };
    },
  } });
  assert.deepEqual(await service.verifyLoginChallenge({ challengeToken: "opaque-challenge", code: "123456" }), { userId: "u-1", role: "ADMIN", authVersion: 9, mfaVerifiedAt, assuranceLevel: "TOTP_VERIFIED" });
  await assert.rejects(service.verifyLoginChallenge({ challengeToken: "opaque-challenge", code: "bad" }), (error) => error.code === "INVALID_MFA_CHALLENGE");
});

test("login challenge preserves recovery-code assurance without a TOTP timestamp", async () => {
  const service = createMfaService({ environment, persistence: {
    completeLoginChallenge: async ({ code }) => {
      assert.equal(code, "a".repeat(32));
      return { userId: "u-1", role: "USER", authVersion: 2, assuranceLevel: "RECOVERY_CODE_VERIFIED", mfaVerifiedAt: null };
    },
  } });
  assert.deepEqual(await service.verifyLoginChallenge({ challengeToken: "opaque-challenge", code: "a".repeat(32) }), {
    userId: "u-1", role: "USER", authVersion: 2, assuranceLevel: "RECOVERY_CODE_VERIFIED", mfaVerifiedAt: null,
  });
});

test("recovery-code regeneration requires a TOTP-assured authenticated session and returns one batch", async () => {
  const auth = { userId: "u-1", sessionId: "s-1", authVersion: 7, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date("2026-01-01T00:00:00Z") };
  let persisted;
  const codes = Array.from({ length: 10 }, (_, index) => `code-${index}`);
  const service = createMfaService({ environment, persistence: { createRecoveryCodeBatch: async (input) => { persisted = input; return { batchId: "batch", codes }; } } });
  assert.deepEqual(await service.regenerateRecoveryCodes({ auth, requestId: "req-1" }), { batchId: "batch", codes });
  assert.deepEqual(persisted, { userId: "u-1", sessionId: "s-1", authVersion: 7, mfaVerifiedAt: auth.mfaVerifiedAt, requestId: "req-1" });
  for (const invalid of [{ ...auth, assuranceLevel: "RECOVERY_CODE_VERIFIED" }, { ...auth, sessionId: undefined }, { ...auth, mfaEnabled: false }]) {
    await assert.rejects(service.regenerateRecoveryCodes({ auth: invalid }), (error) => error.code === "MFA_STEP_UP_REQUIRED");
  }
});

test("MFA disablement requires TOTP assurance and invokes session-revoking persistence", async () => {
  const auth = { userId: "u-1", sessionId: "s-1", authVersion: 7, role: "USER", assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: new Date() };
  let call;
  const service = createMfaService({ environment, persistence: { disableMfa: async (input) => { call = input; return { disabled: true }; } } });
  assert.deepEqual(await service.disableMfa({ auth, requestId: "req-2" }), { disabled: true });
  assert.deepEqual(call, { userId: "u-1", sessionId: "s-1", authVersion: 7, requestId: "req-2" });
  await assert.rejects(service.disableMfa({ auth: { ...auth, assuranceLevel: "RECOVERY_CODE_VERIFIED" } }), (error) => error.code === "MFA_STEP_UP_REQUIRED");
});
