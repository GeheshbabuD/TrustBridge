# TB-BE-051 — Ledger and Escrow Balance Reconciliation

## Scope and accounting model

Escrow is an internal workflow/accounting projection, not a custody claim. Each escrow is scoped to a transaction and currency. The existing double-entry ledger is authoritative for the net `ESCROW_LIABILITY` amount: credits increase the liability; debits decrease it. Escrow funding, release and refunds are expected to move the projection and liability by the same integer-minor-unit amount in one committed transaction. A partial refund leaves the remaining balance funded; full refund and release end at zero.

Payment capture is not provider settlement. Reconciliation checks only internal consistency and does not establish settlement, custody, provider finality or authorization to move money.

## Reconciliation contract

`createEscrowService(...).reconcileLedger({ transactionId })` is an internal read-only operation. It reads one transaction, its escrow, ledger accounts/entries, journals and escrow operations. The query executes in a PostgreSQL `REPEATABLE READ` interactive transaction and issues `SET TRANSACTION READ ONLY` before reads. Atomic financial commits are therefore observed as a consistent pre- or post-operation snapshot; the reconciler takes no financial row locks and performs no writes.

It returns a deterministic structured report: transaction/status, currency, escrow and net liability balances as integer strings, journal/operation counts, `CONSISTENT` or `DISCREPANCY`, and sorted discrepancy codes with counts. It emits no participant PII, provider credentials or evidence. Database failures return a sanitized unavailable error. Reports are not persisted and no automatic repair exists.

Checks include missing escrow records for funded/finalized states; escrow-to-liability balance mismatch; negative or status-inconsistent balances; missing liability accounts; incorrect account, entry, journal, transaction or currency scope; nonpositive/invalid entries; too few journal entries; debit/credit imbalance; repeated journal operation IDs or duplicate journal lines; successful operations without linked journals; unsuccessful operations with journal links; orphan journals; operation-to-journal amount mismatch; duplicate successful funding/release/refund operations; and unsupported reversal/state links.

## Existing enforcement and limits

`src/services/escrow.service.js` locks the transaction for funding and operation authorization/finalization. It conditionally updates transaction versions, uses unique operation/idempotency keys and worker leases, and posts journals atomically with escrow, transaction history and audit changes. The ledger migration adds deferred commit-time journal balance/minimum-entry checks and rejects journal/entry updates and deletes. Reconciliation provides independent detection; it does not replace these write-path controls.

The schema has `LedgerJournal.reversalOfJournalId`, but no supported transaction `REVERSED` state or application reversal operation currently exists. A linked compensating journal contributes to the liability net; unsupported reversal/state combinations are reported. Provider-side chargebacks, settlement reversals and recovery remain separate, unresolved work. No schema field or migration was needed.

The service is callable internally through the escrow service, but there is no scheduled full-ledger scan, admin endpoint, persisted discrepancy queue or alert delivery. Operators must invoke it for selected transaction IDs; production monitoring cadence and alert ownership remain to be designed. It does not scan all transactions in one batch.

## Safety and tests

The evaluator never mutates or repairs financial records. Existing PostgreSQL constraints make malformed posted journals difficult to create through ordinary database operations; malformed snapshots are tested synthetically rather than by altering historical records. Unit coverage exercises balanced funding, missing/duplicate/unbalanced journals, incorrect escrow balance, partial/full refunds, release, compensating reversal arithmetic, unsupported reversed state, deterministic repeated output, and read-only repeatable-read setup. Isolated PostgreSQL coverage races reconciliation with an uncommitted funding posting using independent clients and verifies a consistent snapshot and rollback. No payment-provider calls occur.

Remaining limitations: reversal/refund/chargeback business policy is not implemented here; reconciliation is per-transaction and caller-triggered; corrupted rows protected by database constraints are covered by evaluator tests, not destructive catalog mutation; and this audit does not verify provider settlement/custody.

## TB-BE-051A PostgreSQL verification (2026-11-12)

Test isolation was corrected in `tests/postgres/escrow-ledger.integration.test.js`: the test no longer runs a global outbox batch and asserts on whichever synthetic events happen to be eligible. It exercises execution leases/reconciliation by the exact operation IDs created by that test and updates only their own outbox rows. Prior-run outbox records are neither deleted nor modified. Release/refund fixtures now include their own balanced funding journal and funding operation, so reconciliation tests model complete accounting rather than an unjournaled starting balance.

Verified on the isolated, identity/migration-checked `trustbridge_tb050_clean` database: funding concurrency, release, full refund, dispute-authorized partial refund followed by release, escrow/liability balance mismatch, duplicate journal-line and missing-operation-journal discrepancy detection, and a read-only `REPEATABLE READ` snapshot while a second client holds an uncommitted funding transaction that later rolls back. Before/after fixture values and counts confirm reconciliation did not write the escrow balance, journal, entry or operation records. No application service, schema or migration changed. Unit evaluator tests cover unbalanced/missing journals and invalid operation journal links. No pre-existing financial records were changed; deliberately posted test journals remain in the isolated test database.
