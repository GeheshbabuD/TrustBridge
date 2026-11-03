-- CreateEnum
CREATE TYPE "MfaChallengePurpose" AS ENUM ('LOGIN', 'STEP_UP', 'ACCOUNT_RECOVERY');

-- CreateEnum
CREATE TYPE "AccountRecoveryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecoveryApprovalDecision" AS ENUM ('APPROVE', 'REJECT');

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "auth_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "auth_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "user_mfa" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA,
    "secret_nonce" BYTEA,
    "secret_auth_tag" BYTEA,
    "secret_key_id" VARCHAR(128),
    "secret_key_version" INTEGER,
    "pending_ciphertext" BYTEA,
    "pending_nonce" BYTEA,
    "pending_auth_tag" BYTEA,
    "pending_key_id" VARCHAR(128),
    "pending_key_version" INTEGER,
    "pending_expires_at" TIMESTAMPTZ(6),
    "enabled_at" TIMESTAMPTZ(6),
    "last_accepted_time_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(6),
    "invalidated_at" TIMESTAMPTZ(6),

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "purpose" "MfaChallengePurpose" NOT NULL,
    "auth_version" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_recovery_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "status" "AccountRecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "identity_verified_at" TIMESTAMPTZ(6),
    "identity_verification_ref" VARCHAR(255),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_approvals" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "decision" "RecoveryApprovalDecision" NOT NULL,
    "reason_code" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_mfa_user_id_key" ON "user_mfa"("user_id");

-- CreateIndex
CREATE INDEX "user_mfa_enabled_updated_idx" ON "user_mfa"("enabled_at", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_batch_state_idx" ON "mfa_recovery_codes"("user_id", "batch_id", "consumed_at", "invalidated_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_token_hash_key" ON "mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_purpose_expiry_idx" ON "mfa_challenges"("user_id", "purpose", "expires_at");

-- CreateIndex
CREATE INDEX "mfa_challenges_expiry_consumed_idx" ON "mfa_challenges"("expires_at", "consumed_at");

-- CreateIndex
CREATE INDEX "account_recovery_requests_user_status_created_idx" ON "account_recovery_requests"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "account_recovery_requests_status_expiry_idx" ON "account_recovery_requests"("status", "expires_at");

-- CreateIndex
CREATE INDEX "recovery_approvals_approver_created_idx" ON "recovery_approvals"("approver_id", "created_at");

-- CreateIndex
CREATE INDEX "recovery_approvals_request_decision_created_idx" ON "recovery_approvals"("request_id", "decision", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_approvals_request_approver_key" ON "recovery_approvals"("request_id", "approver_id");

-- AddForeignKey
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "account_recovery_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Custom additive integrity checks for MFA envelope completeness and workflow state.
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_secret_envelope_complete_check" CHECK (
    ("secret_ciphertext" IS NULL AND "secret_nonce" IS NULL AND "secret_auth_tag" IS NULL AND "secret_key_id" IS NULL AND "secret_key_version" IS NULL)
    OR
    ("secret_ciphertext" IS NOT NULL AND octet_length("secret_ciphertext") > 0 AND "secret_nonce" IS NOT NULL AND octet_length("secret_nonce") = 12 AND "secret_auth_tag" IS NOT NULL AND octet_length("secret_auth_tag") = 16 AND "secret_key_id" IS NOT NULL AND length("secret_key_id") > 0 AND "secret_key_version" > 0)
);

ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_pending_envelope_complete_check" CHECK (
    ("pending_ciphertext" IS NULL AND "pending_nonce" IS NULL AND "pending_auth_tag" IS NULL AND "pending_key_id" IS NULL AND "pending_key_version" IS NULL AND "pending_expires_at" IS NULL)
    OR
    ("pending_ciphertext" IS NOT NULL AND octet_length("pending_ciphertext") > 0 AND "pending_nonce" IS NOT NULL AND octet_length("pending_nonce") = 12 AND "pending_auth_tag" IS NOT NULL AND octet_length("pending_auth_tag") = 16 AND "pending_key_id" IS NOT NULL AND length("pending_key_id") > 0 AND "pending_key_version" > 0 AND "pending_expires_at" IS NOT NULL)
);

ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_enabled_requires_secret_check" CHECK (
    "enabled_at" IS NULL OR "secret_ciphertext" IS NOT NULL
);

ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_time_step_nonnegative_check" CHECK (
    "last_accepted_time_step" IS NULL OR "last_accepted_time_step" >= 0
);

ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0);
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_auth_version_nonnegative_check" CHECK ("auth_version" >= 0);
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_single_terminal_time_check" CHECK (
    "consumed_at" IS NULL OR "invalidated_at" IS NULL
);
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_version_positive_check" CHECK ("version" > 0);
ALTER TABLE "account_recovery_requests" ADD CONSTRAINT "account_recovery_requests_identity_verification_pair_check" CHECK (
    ("identity_verified_at" IS NULL AND "identity_verification_ref" IS NULL)
    OR ("identity_verified_at" IS NOT NULL AND "identity_verification_ref" IS NOT NULL AND length("identity_verification_ref") > 0)
);
