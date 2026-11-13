# TB-BE-052B — Reconciliation Persistence Foundation

**Status:** Persistence foundation implemented and verified; TB-BE-052 remains IN PROGRESS.

## Scope delivered

Added three operational Prisma models and corresponding PostgreSQL enums:

- LedgerReconciliationRun stores an idempotency key, trigger/status, fixed cutoff, caller-supplied positive item/page bounds, snapshot counts, continuation marker, sanitized error code, timestamps, retry count and run lease.
- LedgerReconciliationRunItem stores the frozen transaction-ID eligibility set with deterministic ordinal, item status, snapshot timestamp, retry/lease state, attempt count and sanitized error code.
- LedgerReconciliationFinding stores one stable discrepancy code per transaction, open/resolved state, occurrence and allowlisted expected/observed counts, lifecycle timestamps and run references.

All foreign keys use restrictive deletion. Database uniqueness protects run idempotency, item (run, transaction) and (run, ordinal), and finding (transaction, discrepancy code). Claim-oriented indexes support later conditional run/item leases. Findings contain no user PII, evidence, provider identifiers, payment/escrow balances, credentials, or arbitrary payloads. These operational models have no financial posting relations and cannot represent or mutate financial state by themselves.

## Migration

Additive migration: prisma/migrations/20261112120000_ledger_reconciliation_persistence/migration.sql.

It creates four enum types and three new tables with restrictive foreign keys, unique indexes, claim/query indexes and nonnegative counter checks. It does not alter, backfill, or delete existing data or modify transactions, payments, escrow, journals, ledger entries, or operations.

Applied only to the isolated test database trustbridge_tb050_clean after read-only preflight confirmed PostgreSQL 17.10, port 5432, IPv6 loopback server/client addresses, exactly the prior 15 repository migrations applied, no unfinished migrations, and this migration as the only pending migration. Post-apply catalog verification found all three tables, all four enums with expected labels, and the successful migration record. Development database Trustbridge and production were not accessed.

## Verification

- npx.cmd prisma format — passed.
- npx.cmd prisma validate — passed.
- npx.cmd prisma generate — passed (Prisma Client 7.10.1).
- node --test tests/unit/ledger-reconciliation-persistence-schema.test.js tests/unit/ledger-reconciliation.test.js tests/unit/migration-integrity.test.js — 11 passed, 0 failed.
- node --experimental-strip-types --test tests/postgres/ledger-reconciliation-persistence.integration.test.js with TRUSTBRIDGE_RECONCILIATION_PG_TESTS=1 and TRUSTBRIDGE_PG_TEST_DATABASE=trustbridge_tb050_clean — 1 passed, 0 failed, 0 skipped. It used two independent Prisma clients and verified database uniqueness, one conditional lease-claim winner, and no financial-row changes.

## Not implemented in this stage

No batch service, eligibility query/snapshot creator, finding upsert/resolution policy, admin API, authorization, worker, scheduler, operator alerting, retention/purge process, or automatic repair was added. The approved design's 50/100 run and 20-item page limits remain service-level policy to validate before execution; the schema requires positive persisted bounds and does not hard-code those provisional maxima. The existing read-only, repeatable-read per-transaction reconciler is unchanged.

Next: implement the bounded orchestration service over the existing read-only reconciler, with ADMIN/recent-TOTP authorization and idempotent run creation, then add API/worker behavior and operational tests.
