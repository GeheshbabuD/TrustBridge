-- Add purpose/resource/session-bound MFA step-up assurance to durable challenges.
-- Existing LOGIN and ACCOUNT_RECOVERY rows retain NULL for all new columns.
ALTER TABLE "mfa_challenges"
    ADD COLUMN "session_id" UUID,
    ADD COLUMN "operation_purpose" VARCHAR(80),
    ADD COLUMN "resource_type" VARCHAR(64),
    ADD COLUMN "resource_id" VARCHAR(128),
    ADD COLUMN "mfa_enabled_at" TIMESTAMPTZ(6),
    ADD COLUMN "verified_at" TIMESTAMPTZ(6);

ALTER TABLE "mfa_challenges"
    ADD CONSTRAINT "mfa_challenges_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "refresh_tokens"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "mfa_challenges_step_up_assurance_idx"
    ON "mfa_challenges"("user_id", "session_id", "operation_purpose", "resource_type", "resource_id", "verified_at");

CREATE INDEX "mfa_challenges_session_consumed_idx"
    ON "mfa_challenges"("session_id", "consumed_at");

ALTER TABLE "mfa_challenges"
    ADD CONSTRAINT "mfa_challenges_step_up_binding_check" CHECK (
      (
        "purpose" = 'STEP_UP'
        AND "session_id" IS NOT NULL
        AND "operation_purpose" IS NOT NULL
        AND "resource_type" IS NOT NULL
        AND "resource_id" IS NOT NULL
        AND "mfa_enabled_at" IS NOT NULL
        AND (
          ("verified_at" IS NULL AND "consumed_at" IS NULL)
          OR ("verified_at" IS NOT NULL AND "consumed_at" = "verified_at")
        )
      )
      OR (
        "purpose" <> 'STEP_UP'
        AND "session_id" IS NULL
        AND "operation_purpose" IS NULL
        AND "resource_type" IS NULL
        AND "resource_id" IS NULL
        AND "mfa_enabled_at" IS NULL
        AND "verified_at" IS NULL
      )
    );
