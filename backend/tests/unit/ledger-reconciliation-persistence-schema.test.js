import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = await readFile(new URL("../../prisma/migrations/20261112120000_ledger_reconciliation_persistence/migration.sql", import.meta.url), "utf8");

function block(kind, name) {
  const expression = new RegExp(kind + " " + name + " \\{([\\s\\S]*?)\\n\\}");
  const match = schema.match(expression);
  assert.ok(match, "expected " + kind + " " + name);
  return match[1];
}

test("reconciliation persistence schema defines run, eligibility-item and finding lifecycles", () => {
  assert.match(block("enum", "LedgerReconciliationRunStatus"), /QUEUED[\s\S]*RUNNING[\s\S]*COMPLETED[\s\S]*PARTIAL[\s\S]*FAILED/);
  assert.match(block("enum", "LedgerReconciliationItemStatus"), /PENDING[\s\S]*PROCESSING[\s\S]*CONSISTENT[\s\S]*DISCREPANCY[\s\S]*FAILED/);
  assert.match(block("enum", "LedgerReconciliationFindingStatus"), /OPEN[\s\S]*RESOLVED/);
  assert.match(block("model", "LedgerReconciliationRun"), /idempotencyKey\s+String\s+@unique/);
  assert.match(block("model", "LedgerReconciliationRun"), /itemLimit\s+Int/);
  assert.match(block("model", "LedgerReconciliationRunItem"), /@@unique\(\[runId, transactionId\]/);
  assert.match(block("model", "LedgerReconciliationRunItem"), /@@unique\(\[runId, ordinal\]/);
  assert.match(block("model", "LedgerReconciliationFinding"), /@@unique\(\[transactionId, discrepancyCode\]/);
});

test("reconciliation persistence stores only operational identifiers, counts and safe codes", () => {
  const run = block("model", "LedgerReconciliationRun");
  const item = block("model", "LedgerReconciliationRunItem");
  const finding = block("model", "LedgerReconciliationFinding");
  const all = run + "\n" + item + "\n" + finding;
  assert.match(run, /leaseOwner[\s\S]*leaseExpiresAt[\s\S]*lastErrorCode/);
  assert.match(item, /transactionId[\s\S]*ordinal[\s\S]*attemptCount[\s\S]*snapshotAt/);
  assert.match(finding, /discrepancyCode[\s\S]*occurrenceCount[\s\S]*expectedCount[\s\S]*observedCount/);
  assert.doesNotMatch(all, /email|evidence|credential|provider|balanceMinor|amountMinor|payload|rawError/i);
  assert.doesNotMatch(all, /LedgerEntry|LedgerJournal|EscrowOperation\s+@relation/);
});

test("migration is additive, restrictive and does not touch financial records", () => {
  for (const table of ["ledger_reconciliation_runs", "ledger_reconciliation_run_items", "ledger_reconciliation_findings"]) {
    assert.match(migration, new RegExp('CREATE TABLE "' + table + '"'));
  }
  assert.match(migration, /ledger_reconciliation_runs_idempotency_key/);
  assert.match(migration, /ledger_reconciliation_run_items_run_transaction_key/);
  assert.match(migration, /ledger_reconciliation_findings_transaction_code_key/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /item_limit" > 0/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+"(?:transactions|escrows|payment_attempts|ledger_[^"]+)")\b/i);
  assert.doesNotMatch(migration, /ALTER TABLE "(?:transactions|escrows|payment_attempts|ledger_[^"]+)"/i);
});
