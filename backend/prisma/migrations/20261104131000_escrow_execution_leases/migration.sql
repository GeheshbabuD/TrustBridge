ALTER TABLE "escrow_operations"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lease_owner" VARCHAR(128),
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6);

CREATE INDEX "escrow_operations_retry_lease_idx"
  ON "escrow_operations"("status", "next_attempt_at", "lease_expires_at");

ALTER TABLE "escrow_operations"
  ADD CONSTRAINT "escrow_operations_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0);
