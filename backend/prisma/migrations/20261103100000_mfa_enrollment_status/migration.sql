-- CreateEnum
CREATE TYPE "MfaEnrollmentStatus" AS ENUM ('DISABLED', 'PENDING', 'ENABLED');

-- AlterTable
ALTER TABLE "user_mfa" ADD COLUMN     "enrollment_status" "MfaEnrollmentStatus" NOT NULL DEFAULT 'DISABLED';

-- Keep explicit enrollment status coherent with active and pending envelopes.
ALTER TABLE "user_mfa" ADD CONSTRAINT "mfa_enrollment_status_consistency_check" CHECK (
    ("enrollment_status" = 'DISABLED' AND "enabled_at" IS NULL AND "secret_ciphertext" IS NULL)
    OR ("enrollment_status" = 'PENDING' AND "pending_ciphertext" IS NOT NULL)
    OR ("enrollment_status" = 'ENABLED' AND "enabled_at" IS NOT NULL AND "secret_ciphertext" IS NOT NULL)
);
