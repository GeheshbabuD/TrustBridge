import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = await readFile(new URL("../../prisma/migrations/20261103090000_mfa_persistence/migration.sql", import.meta.url), "utf8");
const statusMigration = await readFile(new URL("../../prisma/migrations/20261103100000_mfa_enrollment_status/migration.sql", import.meta.url), "utf8");
const stepUpMigration = await readFile(new URL("../../prisma/migrations/20261103170000_step_up_assurance/migration.sql", import.meta.url), "utf8");
const assuranceMigration = await readFile(new URL("../../prisma/migrations/20261104110000_mfa_assurance_level/migration.sql", import.meta.url), "utf8");
const legacyAdminEnrollmentMigration = await readFile(new URL("../../prisma/migrations/20261103190000_legacy_admin_mfa_enrollment/migration.sql", import.meta.url), "utf8");
const legacyAdminVerifyMigration = await readFile(new URL("../../prisma/migrations/20261103191000_legacy_admin_mfa_verification/migration.sql", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} in canonical Prisma schema`);
  return match[1];
};

test("MFA persistence uses restrictive user relations and encrypted envelope metadata", () => {
  const mfa = modelBlock("UserMfa");
  for (const field of ["secretCiphertext", "secretNonce", "secretAuthTag", "secretKeyId", "secretKeyVersion", "pendingCiphertext", "pendingExpiresAt", "enabledAt", "lastAcceptedTimeStep"]) assert.match(mfa, new RegExp(`\\b${field}\\b`));
  assert.match(mfa, /userId\s+String\s+@unique/);
  assert.match(mfa, /enrollmentStatus\s+MfaEnrollmentStatus/);
  assert.match(mfa, /user\s+User[\s\S]*onDelete: Restrict/);
  assert.doesNotMatch(mfa, /secret\s+String/);
});

test("recovery hashes are unique and records support single-use batch invalidation", () => {
  const recovery = modelBlock("MfaRecoveryCode");
  assert.match(recovery, /codeHash\s+String\s+@unique/);
  assert.match(recovery, /batchId\s+String/);
  assert.match(recovery, /consumedAt\s+DateTime\?/);
  assert.match(recovery, /invalidatedAt\s+DateTime\?/);
  assert.match(recovery, /@@index\(\[userId, batchId, consumedAt, invalidatedAt\]/);
  assert.doesNotMatch(recovery, /rawCode|plaintext|secret\s+String/);
});

test("durable MFA challenges and admin recovery require unique distinct approvers", () => {
  const challenge = modelBlock("MfaChallenge");
  assert.match(challenge, /tokenHash\s+String\s+@unique/);
  assert.match(challenge, /attemptCount\s+Int/);
  assert.match(challenge, /authVersion\s+Int/);
  const request = modelBlock("AccountRecoveryRequest");
  assert.match(request, /identityVerifiedAt\s+DateTime\?/);
  assert.match(request, /version\s+Int/);
  assert.match(request, /status\s+AccountRecoveryStatus/);
  const approval = modelBlock("RecoveryApproval");
  assert.match(approval, /@@unique\(\[requestId, approverId\]/);
  assert.match(approval, /decision\s+RecoveryApprovalDecision/);
  assert.match(approval, /approver\s+User[\s\S]*onDelete: Restrict/);
});

test("legacy ADMIN enrollment authorizations use distinct additive purpose values", () => {
  const enumBlock = schema.match(/enum MfaChallengePurpose \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(enumBlock);
  for (const value of ["LOGIN", "STEP_UP", "ACCOUNT_RECOVERY", "LEGACY_ADMIN_MFA_ENROLL", "LEGACY_ADMIN_MFA_VERIFY"]) assert.match(enumBlock, new RegExp(`\\b${value}\\b`));
  assert.match(legacyAdminEnrollmentMigration, /ALTER TYPE "MfaChallengePurpose" ADD VALUE 'LEGACY_ADMIN_MFA_ENROLL'/);
  assert.match(legacyAdminVerifyMigration, /ALTER TYPE "MfaChallengePurpose" ADD VALUE 'LEGACY_ADMIN_MFA_VERIFY'/);
  assert.doesNotMatch(`${legacyAdminEnrollmentMigration}\n${legacyAdminVerifyMigration}`, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE)\b/i);
});

test("refresh records can later bind MFA assurance and account authorization version", () => {
  assert.match(modelBlock("User"), /authVersion\s+Int/);
  const refresh = modelBlock("RefreshToken");
  assert.match(refresh, /authVersion\s+Int/);
  assert.match(refresh, /mfaVerifiedAt\s+DateTime\?/);
});

test("persistent MFA assurance enum, mapped refresh field and legacy backfill are additive", () => {
  assert.match(schema, /enum MfaAssuranceLevel\s*\{\s*PASSWORD_ONLY\s*TOTP_VERIFIED\s*RECOVERY_CODE_VERIFIED\s*\}/);
  assert.equal((schema.match(/\bPASSWORD_ONLY\b/g) ?? []).length >= 1, true);
  const refresh = modelBlock("RefreshToken");
  assert.match(refresh, /assuranceLevel\s+MfaAssuranceLevel\s+@default\(PASSWORD_ONLY\)\s+@map\("assurance_level"\)/);
  assert.match(refresh, /mfaVerifiedAt\s+DateTime\?\s+@map\("mfa_verified_at"\)/);
  assert.match(assuranceMigration, /CREATE TYPE "MfaAssuranceLevel" AS ENUM/);
  assert.match(assuranceMigration, /ALTER TABLE "refresh_tokens"\s+ADD COLUMN "assurance_level" "MfaAssuranceLevel" NOT NULL DEFAULT 'PASSWORD_ONLY'/);
  assert.match(assuranceMigration, /WHEN "mfa_verified_at" IS NOT NULL THEN 'TOTP_VERIFIED'/);
  assert.match(assuranceMigration, /ELSE 'PASSWORD_ONLY'/);
  assert.match(assuranceMigration, /UPDATE "refresh_tokens"\s+SET "assurance_level" = CASE\s+WHEN "mfa_verified_at" IS NOT NULL THEN 'TOTP_VERIFIED'::"MfaAssuranceLevel"\s+ELSE 'PASSWORD_ONLY'::"MfaAssuranceLevel"\s+END;/);
  assert.doesNotMatch(assuranceMigration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(assuranceMigration, /UPDATE\s+"refresh_tokens"[^;]*(mfa_verified_at\s*=|created_at\s*=|expires_at\s*=)/is);
});

test("step-up assurance schema binds a challenge to refresh session, purpose resource and MFA enrollment", () => {
  const challenge = modelBlock("MfaChallenge");
  for (const field of ["sessionId", "operationPurpose", "resourceType", "resourceId", "mfaEnabledAt", "verifiedAt"]) assert.match(challenge, new RegExp(`\\b${field}\\b`));
  assert.match(challenge, /session\s+RefreshToken\?/);
  assert.match(challenge, /@@index\(\[userId, sessionId, operationPurpose, resourceType, resourceId, verifiedAt\]/);
  assert.match(challenge, /@@index\(\[sessionId, consumedAt\]/);
  assert.match(modelBlock("RefreshToken"), /stepUpChallenges\s+MfaChallenge\[\]/);
  assert.match(stepUpMigration, /mfa_challenges_step_up_binding_check/);
  assert.match(stepUpMigration, /mfa_challenges_session_id_fkey/);
  assert.doesNotMatch(stepUpMigration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
});

test("MFA migration is additive, restrictive, and includes the reviewed checks", () => {
  assert.doesNotMatch(`${migration}\n${statusMigration}`, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  for (const name of ["user_mfa", "mfa_recovery_codes", "mfa_challenges", "account_recovery_requests", "recovery_approvals"]) assert.match(migration, new RegExp(`CREATE TABLE "${name}"`));
  assert.equal((migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? []).length, 7);
  for (const name of ["user_mfa_secret_envelope_complete_check", "user_mfa_pending_envelope_complete_check", "user_mfa_enabled_requires_secret_check", "user_mfa_time_step_nonnegative_check", "mfa_challenges_attempt_count_nonnegative_check", "mfa_challenges_auth_version_nonnegative_check", "mfa_recovery_codes_single_terminal_time_check", "account_recovery_requests_version_positive_check", "account_recovery_requests_identity_verification_pair_check"]) assert.match(migration, new RegExp(name));
  assert.match(statusMigration, /mfa_enrollment_status_consistency_check/);
  assert.doesNotMatch(migration, /postgres(?:ql)?:\/\/|password|secret-key-value/i);
});
