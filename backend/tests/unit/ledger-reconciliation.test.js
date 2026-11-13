import assert from "node:assert/strict";
import test from "node:test";
import { createLedgerReconciliationService, evaluateEscrowLedgerSnapshot } from "../../src/services/ledger-reconciliation.service.js";

const transactionId = "transaction-a";
const journal = (id, operationId, entries, reversalOfJournalId = null) => ({ id, operationId, transactionId, currency: "INR", reversalOfJournalId, entries });
const entry = (accountId, accountCode, direction, amountMinor, transaction = transactionId) => ({ accountId, account: { accountCode }, transactionId: transaction, currency: "INR", direction, amountMinor: BigInt(amountMinor) });
const fixture = () => {
  const fundingEntries = [entry("clearing", "PROVIDER_CLEARING", "DEBIT", 10000), entry("liability", "ESCROW_LIABILITY", "CREDIT", 10000)];
  const fundingJournal = journal("journal-fund", "FUNDING:payment-a", fundingEntries);
  const escrow = { id: "escrow-a", status: "FUNDED", balanceMinor: 10000n, currency: "INR" };
  const ledgerAccounts = [{ id: "liability", escrowId: escrow.id, accountCode: "ESCROW_LIABILITY", accountType: "LIABILITY", currency: "INR", entries: [fundingEntries[1]] }];
  const escrowOperations = [{ id: "operation-fund", transactionId, type: "FUNDING", status: "SUCCEEDED", paymentAttemptId: "payment-a", ledgerJournalId: fundingJournal.id, amountMinor: 10000n, currency: "INR" }];
  return { transaction: { id: transactionId, status: "FUNDED", currency: "INR" }, escrow, ledgerAccounts, ledgerJournals: [fundingJournal], escrowOperations };
};
const codes = (result) => result.discrepancies.map(({ code }) => code);

test("balanced funding is consistent and repeated reconciliation is deterministic", () => {
  const snapshot = fixture();
  const first = evaluateEscrowLedgerSnapshot(snapshot);
  const second = evaluateEscrowLedgerSnapshot(snapshot);
  assert.equal(first.status, "CONSISTENT");
  assert.equal(first.escrowBalanceMinor, "10000");
  assert.equal(first.ledgerLiabilityBalanceMinor, "10000");
  assert.deepEqual(first, second);
});

test("missing journal, missing entries, duplicate posting and unbalanced journal are reported", () => {
  const missing = fixture();
  missing.escrowOperations[0].ledgerJournalId = null;
  assert.ok(codes(evaluateEscrowLedgerSnapshot(missing)).includes("SUCCEEDED_OPERATION_MISSING_JOURNAL"));

  const duplicate = fixture();
  duplicate.ledgerJournals.push({ ...duplicate.ledgerJournals[0], id: "journal-copy" });
  duplicate.ledgerJournals[0].entries.push(duplicate.ledgerJournals[0].entries[0]);
  duplicate.ledgerAccounts[0].entries.push(...duplicate.ledgerAccounts[0].entries);
  duplicate.escrowOperations.push({ ...duplicate.escrowOperations[0], id: "operation-copy", paymentAttemptId: "payment-b", ledgerJournalId: "journal-copy" });
  const duplicateCodes = codes(evaluateEscrowLedgerSnapshot(duplicate));
  assert.ok(duplicateCodes.includes("DUPLICATE_JOURNAL_OPERATION_ID"));
  assert.ok(duplicateCodes.includes("DUPLICATE_JOURNAL_ENTRY"));
  assert.ok(duplicateCodes.includes("DUPLICATE_SUCCESSFUL_FUNDING_OPERATION"));

  const unbalanced = fixture();
  unbalanced.ledgerJournals[0].entries[0].amountMinor = 9999n;
  assert.ok(codes(evaluateEscrowLedgerSnapshot(unbalanced)).includes("UNBALANCED_JOURNAL"));
  const noEntries = fixture();
  noEntries.ledgerJournals[0].entries = [];
  assert.ok(codes(evaluateEscrowLedgerSnapshot(noEntries)).includes("JOURNAL_MISSING_ENTRIES"));
});

test("escrow balance mismatch, missing escrow and unsupported reversed state fail visibly", () => {
  const incorrect = fixture();
  incorrect.escrow.balanceMinor = 9999n;
  assert.ok(codes(evaluateEscrowLedgerSnapshot(incorrect)).includes("ESCROW_LEDGER_BALANCE_MISMATCH"));

  const missing = fixture();
  missing.escrow = null;
  assert.ok(codes(evaluateEscrowLedgerSnapshot(missing)).includes("ESCROW_RECORD_MISSING"));

  const reversed = fixture();
  reversed.transaction.status = "REVERSED";
  reversed.escrow.status = "REVERSED";
  reversed.escrow.balanceMinor = 0n;
  reversed.ledgerAccounts[0].entries.push(entry("liability", "ESCROW_LIABILITY", "DEBIT", 10000));
  reversed.ledgerJournals.push(journal("journal-reversal", "REVERSAL:journal-fund", [entry("liability", "ESCROW_LIABILITY", "DEBIT", 10000), entry("clearing", "PROVIDER_CLEARING", "CREDIT", 10000)], "journal-fund"));
  assert.ok(codes(evaluateEscrowLedgerSnapshot(reversed)).includes("TRANSACTION_ESCROW_STATUS_MISMATCH"));
  assert.equal(evaluateEscrowLedgerSnapshot(reversed).ledgerLiabilityBalanceMinor, "0");
});

test("invalid successful-operation journal link and journal amount are reported", () => {
  const missingLink = fixture();
  missingLink.escrowOperations[0].ledgerJournalId = "missing-journal";
  assert.ok(codes(evaluateEscrowLedgerSnapshot(missingLink)).includes("SUCCEEDED_OPERATION_MISSING_JOURNAL"));

  const wrongLink = fixture();
  wrongLink.ledgerJournals[0].id = "wrong-journal";
  wrongLink.escrowOperations[0].ledgerJournalId = "wrong-journal";
  wrongLink.ledgerJournals[0].entries[1] = entry("liability", "ESCROW_LIABILITY", "CREDIT", 9999);
  wrongLink.ledgerAccounts[0].entries[0] = wrongLink.ledgerJournals[0].entries[1];
  const issues = codes(evaluateEscrowLedgerSnapshot(wrongLink));
  assert.ok(issues.includes("OPERATION_JOURNAL_AMOUNT_MISMATCH"));
  assert.ok(issues.includes("ESCROW_LEDGER_BALANCE_MISMATCH"));
});

test("partial refund, full refund, release and linked compensating reversal reconcile by net liability", () => {
  const partial = fixture();
  const refundEntries = [entry("liability", "ESCROW_LIABILITY", "DEBIT", 3000), entry("clearing", "PROVIDER_CLEARING", "CREDIT", 3000)];
  partial.ledgerJournals.push(journal("journal-partial", "REFUND:operation-partial", refundEntries));
  partial.ledgerAccounts[0].entries.push(refundEntries[0]);
  partial.escrowOperations.push({ id: "operation-partial", transactionId, type: "REFUND", status: "SUCCEEDED", paymentAttemptId: null, ledgerJournalId: "journal-partial", amountMinor: 3000n, currency: "INR" });
  partial.escrow.balanceMinor = 7000n;
  partial.transaction.status = "DELIVERED";
  assert.equal(evaluateEscrowLedgerSnapshot(partial).status, "CONSISTENT");

  for (const outcome of ["RELEASE", "REFUND"]) {
    const final = fixture();
    const debit = entry("liability", "ESCROW_LIABILITY", "DEBIT", 10000);
    const credit = entry("clearing", "PROVIDER_CLEARING", "CREDIT", 10000);
    final.ledgerAccounts[0].entries.push(debit);
    final.ledgerJournals.push(journal(`journal-${outcome.toLowerCase()}`, `${outcome}:operation-final`, [debit, credit], outcome === "REFUND" ? "journal-fund" : null));
    final.escrowOperations.push({ id: "operation-final", transactionId, type: outcome, status: "SUCCEEDED", paymentAttemptId: null, ledgerJournalId: `journal-${outcome.toLowerCase()}`, amountMinor: 10000n, currency: "INR" });
    final.escrow.balanceMinor = 0n;
    final.escrow.status = outcome === "RELEASE" ? "RELEASED" : "REFUNDED";
    final.transaction.status = outcome === "RELEASE" ? "COMPLETED" : "REFUNDED";
    assert.equal(evaluateEscrowLedgerSnapshot(final).status, "CONSISTENT");
  }
});

test("database reconciliation is explicitly read-only at repeatable-read isolation", async () => {
  let options; let readOnlySql = false;
  const snapshot = fixture();
  const tx = {
    $executeRaw: async (strings) => { readOnlySql = strings.join("").trim() === "SET TRANSACTION READ ONLY"; return 0; },
    transaction: { findUnique: async () => ({ ...snapshot.transaction, escrow: snapshot.escrow, ledgerAccounts: snapshot.ledgerAccounts, ledgerJournals: snapshot.ledgerJournals, escrowOperations: snapshot.escrowOperations }) },
  };
  const service = createLedgerReconciliationService({ getClient: async () => ({ $transaction: async (callback, transactionOptions) => { options = transactionOptions; return callback(tx); } }) });
  const report = await service.reconcileTransaction({ transactionId });
  assert.equal(readOnlySql, true);
  assert.equal(options.isolationLevel, "RepeatableRead");
  assert.equal(report.status, "CONSISTENT");
});
