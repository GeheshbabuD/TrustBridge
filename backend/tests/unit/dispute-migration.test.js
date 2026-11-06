import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = await readFile(new URL("../../prisma/migrations/20261107100000_dispute_evidence_management/migration.sql", import.meta.url), "utf8");

test("dispute evidence migration is additive and creates versioned activity history", () => {
  assert.match(schema, /enum DisputeActivityType\s*\{/);
  assert.match(schema, /model DisputeActivity\s*\{/);
  assert.match(migration, /CREATE TYPE "DisputeActivityType"/);
  assert.match(migration, /ALTER TABLE "disputes"[\s\S]*ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /"evidence_deadline_at" TIMESTAMPTZ/);
  assert.match(migration, /"response_deadline_at" TIMESTAMPTZ/);
  assert.match(migration, /"resolution_amount_minor" BIGINT/);
  assert.match(migration, /CREATE TABLE "dispute_activities"/);
  assert.match(migration, /UNIQUE INDEX "dispute_activities_dispute_sequence_key"/);
  assert.match(migration, /REFERENCES "disputes"\("id"\) ON DELETE RESTRICT/);
  assert.match(migration, /REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(migration, /UPDATE "disputes"|UPDATE "transactions"/i);
});

test("partial resolution amount is nullable positive integer minor units only", () => {
  const dispute = schema.match(/model Dispute \{([\s\S]*?)\n\}/)?.[1];
  assert.match(dispute, /resolutionAmountMinor\s+BigInt\?/);
  assert.match(migration, /"disputes_resolution_amount_positive_check" CHECK \("resolution_amount_minor" IS NULL OR "resolution_amount_minor" > 0\)/);
  assert.match(migration, /"disputes_partial_refund_amount_required_check" CHECK \("resolution" IS DISTINCT FROM 'PARTIAL_REFUND' OR "resolution_amount_minor" IS NOT NULL\)/);
  assert.doesNotMatch(schema, /\b(Float|Decimal)\b/);
});
