CREATE TYPE "DisputeActivityType" AS ENUM ('OPENED', 'REVIEW_STARTED', 'RESPONSE', 'EVIDENCE_ADDED', 'RESOLVED', 'CLOSED');

ALTER TABLE "disputes"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "evidence_deadline_at" TIMESTAMPTZ(6),
  ADD COLUMN "response_deadline_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolution_amount_minor" BIGINT;

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_version_positive_check" CHECK ("version" > 0),
  ADD CONSTRAINT "disputes_resolution_amount_positive_check" CHECK ("resolution_amount_minor" IS NULL OR "resolution_amount_minor" > 0),
  ADD CONSTRAINT "disputes_partial_refund_amount_required_check" CHECK ("resolution" IS DISTINCT FROM 'PARTIAL_REFUND' OR "resolution_amount_minor" IS NOT NULL);

CREATE TABLE "dispute_activities" (
  "id" UUID NOT NULL,
  "dispute_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "actor_user_id" UUID,
  "type" "DisputeActivityType" NOT NULL,
  "message" VARCHAR(4000),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispute_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dispute_activities_sequence_positive_check" CHECK ("sequence" > 0),
  CONSTRAINT "dispute_activities_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "dispute_activities_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "dispute_activities_dispute_sequence_key" ON "dispute_activities"("dispute_id", "sequence");
CREATE INDEX "dispute_activities_dispute_created_idx" ON "dispute_activities"("dispute_id", "created_at");
CREATE INDEX "dispute_activities_actor_created_idx" ON "dispute_activities"("actor_user_id", "created_at");
