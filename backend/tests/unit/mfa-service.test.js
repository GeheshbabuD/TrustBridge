import assert from "node:assert/strict";
import test from "node:test";
import { createMfaService, MfaServiceError } from "../../src/services/mfa.service.js";
import { MfaPersistenceError } from "../../src/services/mfa-persistence.service.js";
import { MfaCryptoError } from "../../src/services/mfa-crypto.service.js";

const environment = { nodeEnv: "test", mfa: { totpWindowSteps: 1, loginChallengeTtlSeconds: 300, assuranceMaxAgeSeconds: 900 } };
const user = { id: "u-1", email: "admin@example.test", role: "ADMIN", status: "ACTIVE", mfa: null };
const client = (recoveryCount = 0) => ({ user: { findUnique: async () => user }, mfaRecoveryCode: { count: async () => recoveryCount } });

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
      return { userId: "u-1", role: "ADMIN", authVersion: 9, mfaVerifiedAt };
    },
  } });
  assert.deepEqual(await service.verifyLoginChallenge({ challengeToken: "opaque-challenge", code: "123456" }), { userId: "u-1", role: "ADMIN", authVersion: 9, mfaVerifiedAt });
  await assert.rejects(service.verifyLoginChallenge({ challengeToken: "opaque-challenge", code: "bad" }), (error) => error.code === "INVALID_MFA_CHALLENGE");
});
