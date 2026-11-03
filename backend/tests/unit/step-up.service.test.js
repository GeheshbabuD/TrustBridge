import assert from "node:assert/strict";
import test from "node:test";
import { createMfaService, MfaServiceError } from "../../src/services/mfa.service.js";
import { createStepUpPurposeRegistry } from "../../src/services/step-up-purpose.registry.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const auth = Object.freeze({ userId: "11111111-1111-4111-8111-111111111111", role: "USER", authVersion: 2, sessionId: "22222222-2222-4222-8222-222222222222", mfaEnabled: true, mfaVerifiedAt: new Date(now.getTime() - 60_000) });
const registry = createStepUpPurposeRegistry({
  TEST_SENSITIVE_ACTION: { resourceType: "TRANSACTION", resourceRequired: true, allowedRoles: ["USER"], maxAgeSeconds: 120, additionalAuthorizationRequired: true, oneTime: true },
});
const env = { nodeEnv: "test", mfa: { stepUpChallengeTtlSeconds: 300, totpWindowSteps: 1 } };

test("step-up challenge creation accepts only registered purposes and binds current session/resource", async () => {
  let stored;
  const persistence = { createStepUpChallenge: async (value) => { stored = value; return "opaque-token-never-a-bearer-jwt"; } };
  const service = createMfaService({ environment: env, persistence, stepUpPurposes: registry, now: () => now });
  const result = await service.createStepUpChallenge({ auth, purpose: "TEST_SENSITIVE_ACTION", resourceId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(result.challengeToken, "opaque-token-never-a-bearer-jwt");
  assert.equal(result.expiresAt.getTime(), now.getTime() + 300_000);
  assert.deepEqual(stored, {
    userId: auth.userId, sessionId: auth.sessionId, authVersion: 2, mfaVerifiedAt: auth.mfaVerifiedAt,
    purpose: "TEST_SENSITIVE_ACTION", resourceType: "TRANSACTION", resourceId: "33333333-3333-4333-8333-333333333333",
    allowedRoles: ["USER"],
    expiresAt: result.expiresAt,
  });
  await assert.rejects(service.createStepUpChallenge({ auth, purpose: "RELEASE_ESCROW", resourceId: auth.userId }), (error) => error instanceof MfaServiceError && error.code === "MFA_STEP_UP_PURPOSE_UNSUPPORTED");
  const defaultPurposeService = createMfaService({ environment: env, persistence, now: () => now });
  await assert.rejects(defaultPurposeService.createStepUpChallenge({ auth, purpose: "MFA_RECOVERY_CODES_REGENERATE", resourceId: "33333333-3333-4333-8333-333333333333" }), (error) => error.code === "MFA_STEP_UP_REQUIRED");
});

test("step-up requires authenticated active MFA session and a valid resource binding", async () => {
  const service = createMfaService({ environment: env, persistence: { createStepUpChallenge: async () => "unused" }, stepUpPurposes: registry, now: () => now });
  for (const invalidAuth of [null, { ...auth, mfaEnabled: false }, { ...auth, sessionId: null }, { ...auth, mfaVerifiedAt: null }, { ...auth, role: "ROOT" }]) {
    await assert.rejects(service.createStepUpChallenge({ auth: invalidAuth, purpose: "TEST_SENSITIVE_ACTION", resourceId: "33333333-3333-4333-8333-333333333333" }), (error) => error.code === "MFA_STEP_UP_REQUIRED");
  }
  await assert.rejects(service.createStepUpChallenge({ auth, purpose: "TEST_SENSITIVE_ACTION", resourceId: "not-a-uuid" }), (error) => error.code === "MFA_STEP_UP_RESOURCE_INVALID");
  await assert.rejects(service.createStepUpChallenge({ auth, purpose: "TEST_SENSITIVE_ACTION" }), (error) => error.code === "MFA_STEP_UP_RESOURCE_INVALID");
});

test("verification derives purpose and resource from the stored challenge and returns no session tokens", async () => {
  let input;
  const persistence = { completeStepUpChallenge: async (value) => { input = value; return { purpose: "TEST_SENSITIVE_ACTION", resourceType: "TRANSACTION", resourceId: "33333333-3333-4333-8333-333333333333", verifiedAt: now }; } };
  const service = createMfaService({ environment: env, persistence, stepUpPurposes: registry, now: () => now });
  const result = await service.verifyStepUpChallenge({ auth, challengeToken: "opaque-token", code: "123456", purpose: "FORGED", resourceId: "another-resource" });
  assert.deepEqual(input, { token: "opaque-token", code: "123456", userId: auth.userId, sessionId: auth.sessionId, authVersion: 2, allowedPurposes: { TEST_SENSITIVE_ACTION: { allowedRoles: ["USER"], resourceType: "TRANSACTION", resourceRequired: true } } });
  assert.equal(result.purpose, "TEST_SENSITIVE_ACTION");
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(Object.hasOwn(result, "refreshToken"), false);
});

test("verification failures remain generic and do not accept malformed TOTP input", async () => {
  const service = createMfaService({ environment: env, persistence: { completeStepUpChallenge: async () => null }, stepUpPurposes: registry, now: () => now });
  await assert.rejects(service.verifyStepUpChallenge({ auth, challengeToken: "opaque-token", code: "bad" }), (error) => error.code === "INVALID_MFA_CHALLENGE");
  await assert.rejects(service.verifyStepUpChallenge({ auth, challengeToken: "opaque-token", code: "123456" }), (error) => error.code === "INVALID_MFA_CHALLENGE");
});
