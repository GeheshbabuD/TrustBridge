-- Operational reconciliation records only; no financial state or ledger rows
-- are changed by this additive migration.
CREATE TYPE "LedgerReconciliationRunStatus" AS ENUM (
    'QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'
);

CREATE TYPE "LedgerReconciliationTriggerType" AS ENUM ('MANUAL', 'SCHEDULED');

CREATE TYPE "LedgerReconciliationItemStatus" AS ENUM (
    'PENDING', 'PROCESSING', 'CONSISTENT', 'DISCREPANCY', 'FAILED'
);

CREATE TYPE "LedgerReconciliationFindingStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "ledger_reconciliation_runs" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "trigger_type" "LedgerReconciliationTriggerType" NOT NULL,
    "status" "LedgerReconciliationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "requested_by_id" UUID,
    "cutoff_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "item_limit" INTEGER NOT NULL,
    "page_size" INTEGER NOT NULL,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "scanned_count" INTEGER NOT NULL DEFAULT 0,
    "consistent_count" INTEGER NOT NULL DEFAULT 0,
    "discrepancy_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "continuation_cursor" VARCHAR(128),
    "has_more" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_reconciliation_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_reconciliation_runs_requester_fkey"
        FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_runs_item_limit_check" CHECK ("item_limit" > 0),
    CONSTRAINT "ledger_reconciliation_runs_page_size_check" CHECK ("page_size" > 0),
    CONSTRAINT "ledger_reconciliation_runs_counts_check" CHECK (
        "candidate_count" >= 0 AND "scanned_count" >= 0 AND
        "consistent_count" >= 0 AND "discrepancy_count" >= 0 AND
        "failed_count" >= 0 AND "attempt_count" >= 0
    ),
    CONSTRAINT "ledger_reconciliation_runs_candidate_bound_check" CHECK ("candidate_count" <= "item_limit")
);

CREATE UNIQUE INDEX "ledger_reconciliation_runs_idempotency_key"
    ON "ledger_reconciliation_runs"("idempotency_key");
CREATE INDEX "ledger_reconciliation_runs_claim_idx"
    ON "ledger_reconciliation_runs"("status", "lease_expires_at", "created_at");
CREATE INDEX "ledger_reconciliation_runs_requester_idx"
    ON "ledger_reconciliation_runs"("requested_by_id", "created_at");

CREATE TABLE "ledger_reconciliation_run_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" "LedgerReconciliationItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "retry_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_reconciliation_run_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_reconciliation_run_items_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "ledger_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_run_items_transaction_fkey"
        FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_run_items_ordinal_check" CHECK ("ordinal" >= 0),
    CONSTRAINT "ledger_reconciliation_run_items_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE UNIQUE INDEX "ledger_reconciliation_run_items_run_transaction_key"
    ON "ledger_reconciliation_run_items"("run_id", "transaction_id");
CREATE UNIQUE INDEX "ledger_reconciliation_run_items_run_ordinal_key"
    ON "ledger_reconciliation_run_items"("run_id", "ordinal");
CREATE INDEX "ledger_reconciliation_run_items_claim_idx"
    ON "ledger_reconciliation_run_items"("run_id", "status", "retry_at", "ordinal");
CREATE INDEX "ledger_reconciliation_run_items_transaction_snapshot_idx"
    ON "ledger_reconciliation_run_items"("transaction_id", "snapshot_at");

CREATE TABLE "ledger_reconciliation_findings" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "discrepancy_code" VARCHAR(100) NOT NULL,
    "status" "LedgerReconciliationFindingStatus" NOT NULL DEFAULT 'OPEN',
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "expected_count" INTEGER,
    "observed_count" INTEGER,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "first_run_id" UUID,
    "last_run_id" UUID,
    "resolved_by_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_reconciliation_findings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_reconciliation_findings_transaction_fkey"
        FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_findings_first_run_fkey"
        FOREIGN KEY ("first_run_id") REFERENCES "ledger_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_findings_last_run_fkey"
        FOREIGN KEY ("last_run_id") REFERENCES "ledger_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_findings_resolved_run_fkey"
        FOREIGN KEY ("resolved_by_run_id") REFERENCES "ledger_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ledger_reconciliation_findings_occurrence_count_check" CHECK ("occurrence_count" > 0),
    CONSTRAINT "ledger_reconciliation_findings_counts_check" CHECK (
        ("expected_count" IS NULL OR "expected_count" >= 0) AND
        ("observed_count" IS NULL OR "observed_count" >= 0)
    )
);

CREATE UNIQUE INDEX "ledger_reconciliation_findings_transaction_code_key"
    ON "ledger_reconciliation_findings"("transaction_id", "discrepancy_code");
CREATE INDEX "ledger_reconciliation_findings_status_seen_idx"
    ON "ledger_reconciliation_findings"("status", "last_seen_at");
CREATE INDEX "ledger_reconciliation_findings_first_run_idx"
    ON "ledger_reconciliation_findings"("first_run_id");
CREATE INDEX "ledger_reconciliation_findings_last_run_idx"
    ON "ledger_reconciliation_findings"("last_run_id");
