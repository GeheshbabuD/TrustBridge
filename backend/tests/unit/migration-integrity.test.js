import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../prisma/migrations/20261102153537_init/migration.sql", import.meta.url),
  "utf8",
);

const checks = [
  ['users_email_normalized_check', '"email" = lower(btrim("email"))'],
  ['transactions_amount_minor_positive_check', '"amount_minor" > 0'],
  ['transactions_buyer_seller_distinct_check', '"buyer_id" <> "seller_id"'],
  ['transactions_version_positive_check', '"version" > 0'],
  ['escrows_balance_minor_nonnegative_check', '"balance_minor" >= 0'],
  ['ledger_entries_amount_minor_positive_check', '"amount_minor" > 0'],
  ['transaction_status_history_version_positive_check', '"version" > 0'],
  ['evidence_size_bytes_positive_check', '"size_bytes" > 0'],
  ['webhook_events_attempt_count_nonnegative_check', '"attempt_count" >= 0'],
  ['idempotency_operations_attempt_count_nonnegative_check', '"attempt_count" >= 0'],
  ['outbox_events_attempt_count_nonnegative_check', '"attempt_count" >= 0'],
];

test("initial migration contains the reviewed named row-level integrity checks", () => {
  for (const [name, expression] of checks) {
    assert.ok(
      migration.includes(`CONSTRAINT "${name}" CHECK (${expression})`),
      `Missing or changed custom CHECK constraint ${name}`,
    );
  }
});

test("initial migration draft has no destructive SQL and retains restrictive FKs", () => {
  assert.doesNotMatch(migration, /^\s*(DROP|TRUNCATE|DELETE)\b/im);
  const foreignKeys = [...migration.matchAll(/ON DELETE (\w+)/g)].map((match) => match[1]);
  assert.ok(foreignKeys.length > 0, "Expected foreign keys in the initial migration");
  assert.ok(foreignKeys.every((action) => action === "RESTRICT"));
});
