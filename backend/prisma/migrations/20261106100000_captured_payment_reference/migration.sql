-- Preserve payment attempts while retaining the provider's captured payment ID
-- separately from the order reference used for payment initiation.
ALTER TABLE "payment_attempts"
  ADD COLUMN "captured_payment_id" VARCHAR(255);

CREATE UNIQUE INDEX "payment_attempts_provider_captured_payment_key"
  ON "payment_attempts"("provider", "captured_payment_id");
