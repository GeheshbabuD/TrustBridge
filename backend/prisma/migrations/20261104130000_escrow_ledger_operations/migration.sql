CREATE TYPE "EscrowOperationType" AS ENUM ('FUNDING', 'RELEASE', 'REFUND');

CREATE TABLE "escrow_operations" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "escrow_id" UUID NOT NULL,
    "payment_attempt_id" UUID,
    "ledger_journal_id" UUID,
    "actor_user_id" UUID,
    "type" "EscrowOperationType" NOT NULL,
    "status" "ProviderOperationStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "operation_key" VARCHAR(160) NOT NULL,
    "provider" VARCHAR(64),
    "provider_reference" VARCHAR(255),
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason_code" VARCHAR(100) NOT NULL,
    "failure_code" VARCHAR(100),
    "authorized_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "escrow_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "escrow_operations_transaction_id_fkey"
      FOREIGN KEY ("transaction_id", "currency") REFERENCES "transactions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "escrow_operations_escrow_id_transaction_id_currency_fkey"
      FOREIGN KEY ("escrow_id", "transaction_id", "currency") REFERENCES "escrows"("id", "transaction_id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "escrow_operations_payment_attempt_id_fkey"
      FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "escrow_operations_ledger_journal_id_fkey"
      FOREIGN KEY ("ledger_journal_id") REFERENCES "ledger_journals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "escrow_operations_actor_user_id_fkey"
      FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "escrow_operations_amount_minor_positive_check" CHECK ("amount_minor" > 0)
);

CREATE UNIQUE INDEX "escrow_operations_payment_attempt_key" ON "escrow_operations"("payment_attempt_id");
CREATE UNIQUE INDEX "escrow_operations_ledger_journal_key" ON "escrow_operations"("ledger_journal_id");
CREATE UNIQUE INDEX "escrow_operations_operation_key_key" ON "escrow_operations"("operation_key");
CREATE UNIQUE INDEX "escrow_operations_transaction_idempotency_key" ON "escrow_operations"("transaction_id", "idempotency_key");
CREATE INDEX "escrow_operations_transaction_type_status_idx" ON "escrow_operations"("transaction_id", "type", "status", "created_at");
CREATE INDEX "escrow_operations_escrow_status_created_idx" ON "escrow_operations"("escrow_id", "status", "created_at");
CREATE INDEX "escrow_operations_status_updated_idx" ON "escrow_operations"("status", "updated_at");

-- Posted accounting rows are immutable. Corrections use compensating journals.
CREATE FUNCTION "trustbridge_reject_ledger_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'posted ledger records are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_journals_immutable"
BEFORE UPDATE OR DELETE ON "ledger_journals"
FOR EACH ROW EXECUTE FUNCTION "trustbridge_reject_ledger_mutation"();

CREATE TRIGGER "ledger_entries_immutable"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "trustbridge_reject_ledger_mutation"();

CREATE FUNCTION "trustbridge_only_insert_into_new_journal"() RETURNS trigger AS $$
DECLARE
  journal_xid xid;
BEGIN
  SELECT "xmin" INTO journal_xid FROM "ledger_journals" WHERE "id" = NEW."journal_id" FOR UPDATE;
  IF journal_xid IS NULL OR journal_xid <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'entries may only be added while the journal is first posted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_only_during_journal_posting"
BEFORE INSERT ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "trustbridge_only_insert_into_new_journal"();

-- Deferred until commit so a journal can be assembled from multiple entries
-- within one transaction. Locking the journal parent serializes competing
-- writers before the aggregate check.
CREATE FUNCTION "trustbridge_check_ledger_journal_balance"() RETURNS trigger AS $$
DECLARE
  entry_count BIGINT;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  PERFORM 1 FROM "ledger_journals" WHERE "id" = NEW."journal_id" FOR UPDATE;
  SELECT COUNT(*),
         COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount_minor" ELSE 0 END), 0)
    INTO entry_count, debit_total, credit_total
    FROM "ledger_entries"
   WHERE "journal_id" = NEW."journal_id"
     AND "transaction_id" = NEW."transaction_id"
     AND "currency" = NEW."currency";
  IF entry_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger journal must contain at least two balanced entries' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_journal_balanced"
AFTER INSERT ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "trustbridge_check_ledger_journal_balance"();

CREATE FUNCTION "trustbridge_check_new_ledger_journal"() RETURNS trigger AS $$
DECLARE
  entry_count BIGINT;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  SELECT COUNT(*),
         COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount_minor" ELSE 0 END), 0)
    INTO entry_count, debit_total, credit_total
    FROM "ledger_entries"
   WHERE "journal_id" = NEW."id"
     AND "transaction_id" = NEW."transaction_id"
     AND "currency" = NEW."currency";
  IF entry_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger journal must contain at least two balanced entries' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_journals_require_balanced_entries"
AFTER INSERT ON "ledger_journals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "trustbridge_check_new_ledger_journal"();
