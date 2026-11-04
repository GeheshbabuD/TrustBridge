import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = await readFile(new URL("../../prisma/migrations/20261104130000_transaction_terms_invitations/migration.sql", import.meta.url), "utf8");

test("terms and invitation enums/models map immutable decisions and hash-only invitations", () => {
  for (const value of ["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED", "LEGACY_ACCEPTED"]) assert.match(schema, new RegExp(`enum TermsVersionStatus \\{[\\s\\S]*?\\b${value}\\b`));
  assert.match(schema, /enum TermsDecision\s*\{\s*ACCEPTED\s+REJECTED\s*\}/);
  assert.match(schema, /enum TransactionInvitationStatus\s*\{[\s\S]*?PENDING[\s\S]*?ACCEPTED[\s\S]*?REJECTED[\s\S]*?REVOKED[\s\S]*?\}/);
  assert.match(schema, /model TransactionTermsVersion\s*\{[\s\S]*?transactionId[\s\S]*?version[\s\S]*?proposedById[\s\S]*?amountMinor[\s\S]*?currency[\s\S]*?details[\s\S]*?decisions/);
  assert.match(schema, /@@unique\(\[transactionId, version\]/);
  assert.match(schema, /model TransactionTermsDecision\s*\{[\s\S]*?actorUserId[\s\S]*?@@unique\(\[termsVersionId, actorUserId\]/);
  assert.match(schema, /model TransactionInvitation\s*\{[\s\S]*?tokenHash[\s\S]*?@unique[\s\S]*?expiresAt[\s\S]*?acceptedAt[\s\S]*?rejectedAt[\s\S]*?revokedAt/);
  assert.doesNotMatch(schema, /model TransactionInvitation\s*\{[\s\S]*?token\s+String\s/);
});

test("additive migration backfills transaction snapshots without deleting historical rows", () => {
  for (const value of ["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED", "LEGACY_ACCEPTED"]) assert.match(migration, new RegExp(`CREATE TYPE \\"TermsVersionStatus\\" AS ENUM \\([^;]*'${value}'`));
  assert.match(migration, /INSERT INTO "transaction_terms_versions"[\s\S]*?SELECT "id", "id", 1, "created_by_id", "amount_minor", "currency", "terms"[\s\S]*?CASE WHEN "status" IN \('ACCEPTED', 'AWAITING_PAYMENT', 'FUNDED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED', 'REFUNDED'\)[\s\S]*?THEN 'LEGACY_ACCEPTED'[\s\S]*?ELSE 'PENDING'/);
  assert.match(migration, /ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(migration, /CREATE UNIQUE INDEX "transaction_terms_versions_transaction_version_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "transaction_terms_decisions_version_actor_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "transaction_invitations_token_hash_key"/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+"transactions"\s+(DROP|DELETE)/i);
});
