-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('BUYER', 'SELLER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'ACCEPTED', 'AWAITING_PAYMENT', 'FUNDED', 'IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'RELEASE_PENDING', 'REFUND_PENDING', 'COMPLETED', 'REFUNDED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'PENDING', 'CAPTURED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('UNFUNDED', 'FUNDED', 'RELEASE_PENDING', 'REFUND_PENDING', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProviderOperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiReviewStatus" AS ENUM ('PENDING', 'REVIEWED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "BlockchainOperationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower(btrim("email")))
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "terms" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transactions_amount_minor_positive_check" CHECK ("amount_minor" > 0),
    CONSTRAINT "transactions_buyer_seller_distinct_check" CHECK ("buyer_id" <> "seller_id"),
    CONSTRAINT "transactions_version_positive_check" CHECK ("version" > 0)
);

-- CreateTable
CREATE TABLE "transaction_participants" (
    "transaction_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_participants_pkey" PRIMARY KEY ("transaction_id","user_id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "provider_reference" VARCHAR(255),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "failure_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrows" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "status" "EscrowStatus" NOT NULL DEFAULT 'UNFUNDED',
    "funded_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "escrows_balance_minor_nonnegative_check" CHECK ("balance_minor" >= 0)
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "escrow_id" UUID,
    "account_code" VARCHAR(64) NOT NULL,
    "account_type" "LedgerAccountType" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_journals" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "operation_id" VARCHAR(128) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reversal_of_journal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entries_amount_minor_positive_check" CHECK ("amount_minor" > 0)
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "opened_by_id" UUID NOT NULL,
    "resolved_by_id" UUID,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "category" VARCHAR(80) NOT NULL,
    "description" VARCHAR(4000) NOT NULL,
    "resolution" VARCHAR(4000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "storage_object_key" VARCHAR(512) NOT NULL,
    "original_filename" VARCHAR(255),
    "content_type" VARCHAR(127) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "evidence_size_bytes_positive_check" CHECK ("size_bytes" > 0)
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "notification_type" VARCHAR(80) NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "message" VARCHAR(1000),
    "dedupe_key" VARCHAR(128),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" VARCHAR(128) NOT NULL,
    "request_id" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_assessments" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "status" "AiReviewStatus" NOT NULL DEFAULT 'PENDING',
    "score" INTEGER,
    "risk_level" VARCHAR(32) NOT NULL,
    "indicators" JSONB NOT NULL,
    "recommendation" VARCHAR(100),
    "ruleset_version" VARCHAR(100) NOT NULL,
    "reviewer_id" UUID,
    "review_rationale" VARCHAR(2000),
    "review_outcome" VARCHAR(100),
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" UUID NOT NULL,
    "transaction_id" UUID,
    "dispute_id" UUID,
    "status" "AiReviewStatus" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(64) NOT NULL,
    "model_identifier" VARCHAR(128) NOT NULL,
    "model_version" VARCHAR(128) NOT NULL,
    "analysis_type" VARCHAR(80) NOT NULL,
    "result" JSONB NOT NULL,
    "explainability" JSONB,
    "reviewer_id" UUID,
    "review_rationale" VARCHAR(2000),
    "review_outcome" VARCHAR(100),
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_records" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "status" "BlockchainOperationStatus" NOT NULL DEFAULT 'PENDING',
    "network" VARCHAR(80) NOT NULL,
    "contract_reference" VARCHAR(255),
    "operation_type" VARCHAR(80) NOT NULL,
    "transaction_hash" VARCHAR(128),
    "block_number" BIGINT,
    "block_hash" VARCHAR(128),
    "event_hash" CHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "blockchain_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "family_id" UUID NOT NULL,
    "rotated_from_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "reuse_detected_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_status_history" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "previous_status" "TransactionStatus",
    "new_status" "TransactionStatus" NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transaction_status_history_version_positive_check" CHECK ("version" > 0)
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "provider_account_scope" VARCHAR(128) NOT NULL DEFAULT 'default',
    "event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payment_attempt_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "claimed_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "event_data" JSONB,
    "last_error_code" VARCHAR(100),
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0)
);

-- CreateTable
CREATE TABLE "idempotency_operations" (
    "id" UUID NOT NULL,
    "operation_scope" VARCHAR(128) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "resource_type" VARCHAR(100),
    "resource_id" VARCHAR(128),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_operations_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0)
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_key" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" VARCHAR(128) NOT NULL,
    "transaction_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "transactions_buyer_status_created_idx" ON "transactions"("buyer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "transactions_seller_status_created_idx" ON "transactions"("seller_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "transactions_status_created_idx" ON "transactions"("status", "created_at");

-- CreateIndex
CREATE INDEX "transactions_creator_created_idx" ON "transactions"("created_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_id_currency_key" ON "transactions"("id", "currency");

-- CreateIndex
CREATE INDEX "transaction_participants_user_role_joined_idx" ON "transaction_participants"("user_id", "role", "joined_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_participants_transaction_role_key" ON "transaction_participants"("transaction_id", "role");

-- CreateIndex
CREATE INDEX "payment_attempts_transaction_status_created_idx" ON "payment_attempts"("transaction_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "payment_attempts_provider_status_idx" ON "payment_attempts"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_transaction_idempotency_key" ON "payment_attempts"("transaction_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_reference_key" ON "payment_attempts"("provider", "provider_reference");

-- CreateIndex
CREATE INDEX "escrows_status_updated_idx" ON "escrows"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "escrows_id_transaction_currency_key" ON "escrows"("id", "transaction_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "escrows_transaction_currency_key" ON "escrows"("transaction_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_accounts_transaction_type_currency_idx" ON "ledger_accounts"("transaction_id", "account_type", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_transaction_code_currency_key" ON "ledger_accounts"("transaction_id", "account_code", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_id_transaction_currency_key" ON "ledger_accounts"("id", "transaction_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_escrow_transaction_currency_key" ON "ledger_accounts"("escrow_id", "transaction_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journals_operation_id_key" ON "ledger_journals"("operation_id");

-- CreateIndex
CREATE INDEX "ledger_journals_transaction_created_idx" ON "ledger_journals"("transaction_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_journals_reversal_idx" ON "ledger_journals"("reversal_of_journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journals_id_transaction_currency_key" ON "ledger_journals"("id", "transaction_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_journal_transaction_currency_idx" ON "ledger_entries"("journal_id", "transaction_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_account_transaction_currency_created_idx" ON "ledger_entries"("account_id", "transaction_id", "currency", "created_at");

-- CreateIndex
CREATE INDEX "disputes_transaction_status_created_idx" ON "disputes"("transaction_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "disputes_opener_created_idx" ON "disputes"("opened_by_id", "created_at");

-- CreateIndex
CREATE INDEX "disputes_resolver_resolved_idx" ON "disputes"("resolved_by_id", "resolved_at");

-- CreateIndex
CREATE INDEX "disputes_status_created_idx" ON "disputes"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_storage_object_key_key" ON "evidence"("storage_object_key");

-- CreateIndex
CREATE INDEX "evidence_dispute_created_idx" ON "evidence"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "evidence_uploader_created_idx" ON "evidence"("uploaded_by_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_created_idx" ON "notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_read_created_idx" ON "notifications"("recipient_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_type_created_idx" ON "notifications"("notification_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_dedupe_key" ON "notifications"("recipient_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_created_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_request_created_idx" ON "audit_logs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "risk_assessments_transaction_status_created_idx" ON "risk_assessments"("transaction_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "risk_assessments_reviewer_reviewed_idx" ON "risk_assessments"("reviewer_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "risk_assessments_status_created_idx" ON "risk_assessments"("status", "created_at");

-- CreateIndex
CREATE INDEX "ai_analyses_transaction_status_created_idx" ON "ai_analyses"("transaction_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_analyses_dispute_status_created_idx" ON "ai_analyses"("dispute_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_analyses_model_provenance_idx" ON "ai_analyses"("provider", "model_identifier", "model_version");

-- CreateIndex
CREATE INDEX "ai_analyses_reviewer_reviewed_idx" ON "ai_analyses"("reviewer_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "blockchain_records_transaction_status_created_idx" ON "blockchain_records"("transaction_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "blockchain_records_network_status_created_idx" ON "blockchain_records"("network", "status", "created_at");

-- CreateIndex
CREATE INDEX "blockchain_records_event_hash_idx" ON "blockchain_records"("event_hash");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_records_transaction_idempotency_key" ON "blockchain_records"("transaction_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_records_network_transaction_hash_key" ON "blockchain_records"("network", "transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_rotated_from_key" ON "refresh_tokens"("rotated_from_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_expiry_idx" ON "refresh_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_revocation_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_revocation_idx" ON "refresh_tokens"("family_id", "revoked_at");

-- CreateIndex
CREATE INDEX "transaction_status_history_transaction_created_idx" ON "transaction_status_history"("transaction_id", "created_at");

-- CreateIndex
CREATE INDEX "transaction_status_history_actor_created_idx" ON "transaction_status_history"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "transaction_status_history_status_created_idx" ON "transaction_status_history"("new_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_status_history_transaction_version_key" ON "transaction_status_history"("transaction_id", "version");

-- CreateIndex
CREATE INDEX "webhook_events_status_retry_received_idx" ON "webhook_events"("status", "next_attempt_at", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_provider_status_received_idx" ON "webhook_events"("provider", "status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_payment_attempt_received_idx" ON "webhook_events"("payment_attempt_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_account_event_key" ON "webhook_events"("provider", "provider_account_scope", "event_id");

-- CreateIndex
CREATE INDEX "idempotency_operations_status_lease_created_idx" ON "idempotency_operations"("status", "lease_expires_at", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_operations_resource_idx" ON "idempotency_operations"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "idempotency_operations_expiry_idx" ON "idempotency_operations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_operations_scope_key_key" ON "idempotency_operations"("operation_scope", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_key_key" ON "outbox_events"("event_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_retry_created_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_created_idx" ON "outbox_events"("aggregate_type", "aggregate_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_transaction_created_idx" ON "outbox_events"("transaction_id", "created_at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_participants" ADD CONSTRAINT "transaction_participants_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_participants" ADD CONSTRAINT "transaction_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_transaction_id_currency_fkey" FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_transaction_id_currency_fkey" FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_transaction_id_currency_fkey" FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_escrow_id_transaction_id_currency_fkey" FOREIGN KEY ("escrow_id", "transaction_id", "currency") REFERENCES "escrows"("id", "transaction_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_transaction_id_currency_fkey" FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_reversal_of_journal_id_transaction_id_curr_fkey" FOREIGN KEY ("reversal_of_journal_id", "transaction_id", "currency") REFERENCES "ledger_journals"("id", "transaction_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_transaction_id_currency_fkey" FOREIGN KEY ("journal_id", "transaction_id", "currency") REFERENCES "ledger_journals"("id", "transaction_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_transaction_id_currency_fkey" FOREIGN KEY ("account_id", "transaction_id", "currency") REFERENCES "ledger_accounts"("id", "transaction_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "blockchain_records" ADD CONSTRAINT "blockchain_records_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "refresh_tokens"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_status_history" ADD CONSTRAINT "transaction_status_history_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "transaction_status_history" ADD CONSTRAINT "transaction_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
