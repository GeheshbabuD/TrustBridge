-- TB-BE-051: additive immutable terms snapshots/decisions and hash-only invitations.
CREATE TYPE "TermsVersionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'LEGACY_ACCEPTED');
CREATE TYPE "TermsDecision" AS ENUM ('ACCEPTED', 'REJECTED');
CREATE TYPE "TransactionInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED');

CREATE TABLE "transaction_terms_versions" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "proposed_by_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "details" JSONB NOT NULL,
    "status" "TermsVersionStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_terms_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transaction_terms_versions_version_positive_check" CHECK ("version" > 0),
    CONSTRAINT "transaction_terms_versions_amount_positive_check" CHECK ("amount_minor" > 0)
);

CREATE TABLE "transaction_terms_decisions" (
    "id" UUID NOT NULL,
    "terms_version_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "decision" "TermsDecision" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_terms_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transaction_invitations" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "status" "TransactionInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transaction_invitations_pkey" PRIMARY KEY ("id")
);

-- Preserve current transaction snapshots. CREATED rows remain pending; existing
-- later states are explicitly grandfathered without fabricating decision rows.
INSERT INTO "transaction_terms_versions" (
    "id", "transaction_id", "version", "proposed_by_id", "amount_minor", "currency", "details", "status", "created_at", "updated_at"
)
SELECT "id", "id", 1, "created_by_id", "amount_minor", "currency", "terms",
       CASE WHEN "status" IN ('ACCEPTED', 'AWAITING_PAYMENT', 'FUNDED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED', 'REFUNDED')
            THEN 'LEGACY_ACCEPTED'::"TermsVersionStatus" ELSE 'PENDING'::"TermsVersionStatus" END,
       "created_at", "updated_at"
FROM "transactions";

CREATE UNIQUE INDEX "transaction_terms_versions_transaction_version_key" ON "transaction_terms_versions"("transaction_id", "version");
CREATE INDEX "transaction_terms_versions_lookup_idx" ON "transaction_terms_versions"("transaction_id", "status", "version");
CREATE INDEX "transaction_terms_versions_proposer_idx" ON "transaction_terms_versions"("proposed_by_id", "created_at");
CREATE UNIQUE INDEX "transaction_terms_decisions_version_actor_key" ON "transaction_terms_decisions"("terms_version_id", "actor_user_id");
CREATE INDEX "transaction_terms_decisions_actor_created_idx" ON "transaction_terms_decisions"("actor_user_id", "created_at");
CREATE UNIQUE INDEX "transaction_invitations_token_hash_key" ON "transaction_invitations"("token_hash");
CREATE INDEX "transaction_invitations_transaction_status_idx" ON "transaction_invitations"("transaction_id", "status", "created_at");
CREATE INDEX "transaction_invitations_invitee_expiry_idx" ON "transaction_invitations"("invitee_id", "status", "expires_at");

ALTER TABLE "transaction_terms_versions" ADD CONSTRAINT "transaction_terms_versions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_terms_versions" ADD CONSTRAINT "transaction_terms_versions_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_terms_decisions" ADD CONSTRAINT "transaction_terms_decisions_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "transaction_terms_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_terms_decisions" ADD CONSTRAINT "transaction_terms_decisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_invitations" ADD CONSTRAINT "transaction_invitations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_invitations" ADD CONSTRAINT "transaction_invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transaction_invitations" ADD CONSTRAINT "transaction_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
