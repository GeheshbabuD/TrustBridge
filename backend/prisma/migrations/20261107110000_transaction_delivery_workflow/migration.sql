-- Add delivery submissions and immutable buyer decisions while retaining all
-- existing dispute evidence. Evidence must belong to exactly one parent.
CREATE TYPE "DeliveryDecisionType" AS ENUM ('ACCEPTED', 'CHANGES_REQUESTED');

CREATE TABLE "transaction_deliveries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "description" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transaction_deliveries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "transaction_deliveries_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "transaction_deliveries_transaction_sequence_key" ON "transaction_deliveries"("transaction_id", "sequence");
CREATE INDEX "transaction_deliveries_transaction_created_idx" ON "transaction_deliveries"("transaction_id", "created_at");

CREATE TABLE "delivery_decisions" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "decision" "DeliveryDecisionType" NOT NULL,
    "reason" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_decisions_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "transaction_deliveries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "delivery_decisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "delivery_decisions_delivery_id_key" ON "delivery_decisions"("delivery_id");
CREATE INDEX "delivery_decisions_actor_created_idx" ON "delivery_decisions"("actor_user_id", "created_at");

ALTER TABLE "evidence" ALTER COLUMN "dispute_id" DROP NOT NULL;
ALTER TABLE "evidence" ADD COLUMN "transaction_delivery_id" UUID;
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_transaction_delivery_id_fkey" FOREIGN KEY ("transaction_delivery_id") REFERENCES "transaction_deliveries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_exactly_one_parent_check" CHECK (("dispute_id" IS NOT NULL) <> ("transaction_delivery_id" IS NOT NULL));
CREATE INDEX "evidence_delivery_created_idx" ON "evidence"("transaction_delivery_id", "created_at");
