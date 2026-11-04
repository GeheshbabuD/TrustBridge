CREATE TYPE "MfaAssuranceLevel" AS ENUM (
  'PASSWORD_ONLY',
  'TOTP_VERIFIED',
  'RECOVERY_CODE_VERIFIED'
);

ALTER TABLE "refresh_tokens"
ADD COLUMN "assurance_level" "MfaAssuranceLevel" NOT NULL DEFAULT 'PASSWORD_ONLY';

UPDATE "refresh_tokens"
SET "assurance_level" = CASE
  WHEN "mfa_verified_at" IS NOT NULL THEN 'TOTP_VERIFIED'::"MfaAssuranceLevel"
  ELSE 'PASSWORD_ONLY'::"MfaAssuranceLevel"
END;
