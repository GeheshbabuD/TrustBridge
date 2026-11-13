# TB-BE-052A — Admin Batch Escrow Reconciliation Design

**Phase 1 status at creation:** Design only. The subsequent persistence-foundation implementation is recorded below and in docs/TB-BE-052B_PERSISTENCE_FOUNDATION.md.

## TB-BE-052B persistence foundation status (2026-11-12)

The additive run/item/finding persistence foundation is implemented in the canonical Prisma schema and migration 20261112120000_ledger_reconciliation_persistence. The migration was applied only to the verified isolated PostgreSQL 17.10 database trustbridge_tb050_clean. It adds operational metadata tables and enums only; it does not alter financial tables or existing rows. Schema and catalog verification plus focused persistence tests are recorded in docs/TB-BE-052B_PERSISTENCE_FOUNDATION.md.

This does not implement batch enumeration, run creation authorization, finding upsert/resolution logic, workers, routes, operational alerts, or automatic repair. TB-BE-052 remains in progress.

## Goal and invariants

Allow an authenticated ADMIN to request a bounded asynchronous reconciliation run and inspect its privacy-safe operational status. Reuse `createEscrowService().reconcileLedger({ transactionId })` as the sole financial snapshot evaluator. Each item remains PostgreSQL `REPEATABLE READ` plus `SET TRANSACTION READ ONLY`. Batch orchestration must never call payment, escrow authorization/execution, ledger-posting, transaction-transition, or repair services.

Financial rows are read only. Operational run, item, finding, and audit metadata may be written separately. No user-facing notification templates are used.

## Eligible population and bounds

At run creation, define the candidate set as existing transactions that either:

1. Have an escrow, ledger account, ledger journal, or escrow operation; or
2. Have a status for which the evaluator reports a missing escrow as a discrepancy: `FUNDED`, `IN_PROGRESS`, `DELIVERED`, `DISPUTED`, `RELEASE_PENDING`, `REFUND_PENDING`, `COMPLETED`, or `REFUNDED`.

Capture the candidate IDs and their deterministic order at run creation in `LedgerReconciliationRunItem` rows, unique on `(runId, transactionId)`. This freezes the run population: transactions created or newly becoming eligible after the snapshot are handled by a later run. Per-transaction reconciliation still reads the current consistent snapshot when the item executes; it does not hold one long transaction over the entire run.

Proposed initial bounds (validate with performance testing before deployment): default 50 and maximum 100 transactions per run; worker pages of 20; one active run lease per run; bounded retry count with backoff. A run that reaches its maximum while more candidates remain is `PARTIAL` with a continuation cursor/indicator and may be continued idempotently. The request cannot supply arbitrary transaction IDs or unbounded page sizes.

## API and authorization

- `POST /api/v1/admin/ledger-reconciliation-runs`: authentication, `ADMIN` role, recent TOTP (five-minute policy matching existing admin reads), shared rate-limit bucket, strict bounded body, and an idempotency key. Returns `202` with only run ID/state and accepted item count; duplicate idempotency returns the existing run.
- `GET /api/v1/admin/ledger-reconciliation-runs/:runId`: same ADMIN/recent-TOTP gate and shared rate limit. Returns run state, timestamps, aggregate scanned/consistent/discrepant/failed counts, continuation indicator, and sanitized error codes.
- If detailed findings are approved for the initial stage, expose a separately paginated `GET .../:runId/findings`; return transaction ID and stable discrepancy codes/counts only. Do not return balance snapshots, ledger lines, provider references, evidence, PII, or raw database errors by default. A step-up authorization for this detailed view remains an approval decision; the safer initial release is summary-only.

No public or unauthenticated trigger exists. ADMIN does not gain ownership or participant access to underlying transaction resources; these endpoints expose only the narrowly defined operational report.

## Minimal additive persistence

The schema has no run/finding lifecycle, so existing `OutboxEvent`, `AuditLog`, or `Notification` records are not substitutes. Add only operational tables:

- `LedgerReconciliationRun`: unique idempotency key, status (`QUEUED`, `RUNNING`, `COMPLETED`, `PARTIAL`, `FAILED`), trigger actor, cutoff, candidate/terminal counters, continuation state, sanitized failure code, timestamps, and conditional lease owner/expiry.
- `LedgerReconciliationRunItem`: run and transaction references, status (`PENDING`, `PROCESSING`, `CONSISTENT`, `DISCREPANCY`, `FAILED`), attempt count, lease/retry timestamps, snapshot timestamp, and sanitized failure code; unique `(runId, transactionId)`.
- `LedgerReconciliationFinding`: transaction ID, discrepancy code, occurrence count, active/resolved state, first/last seen timestamps, last successful run reference, and allowlisted count metadata; unique `(transactionId, discrepancyCode)`.

Keep findings code/count based. Numeric balances are financially sensitive and are excluded until product/security approves their storage and retention. Finding lifecycle changes may append privacy-safe `AuditLog` events. A later implementation must use an additive migration and verify it only against the isolated test database.

## Idempotency, concurrency, retries

- The unique request idempotency key prevents duplicate run creation. A duplicate returns the original run without adding duplicate items.
- Workers claim the run with a conditional lease update and claim each run item conditionally. Expired leases permit recovery after a crash; only the lease owner may checkpoint or complete an item.
- Multiple runs may include the same transaction. Finding upserts must be atomic on `(transactionId, discrepancyCode)` and ordered by the item’s snapshot timestamp. An older snapshot finishing late cannot overwrite or resolve newer observations.
- A finding is resolved only after a successful clean reconciliation for that transaction. Failed/unknown items never resolve findings. A partial run does not clear findings for transactions it did not inspect.
- Retry only transient unavailable errors, with bounded exponential backoff and sanitized codes. Exhaustion marks the item/run failed or partial, never consistent. Persist item completion and run counters atomically in the operational tables after the read-only reconciliation transaction has ended.
- No global worker batch may claim unrelated event types. The initial trigger/worker path should be dedicated to reconciliation-run records; it must not call the financial escrow worker or repurpose pending payment/outbox events.

## Privacy-safe operational reporting and audit

The ADMIN summary endpoint is the first operational report. Append an audit event for run request, duplicate request, completion/partial failure, and any finding opened/resolved; include run ID, actor ID where applicable, aggregate counts, stable codes, and timestamps only. Do not log raw findings, PII, evidence, provider information, SQL errors, or numeric balances. Apply response allowlists, shared rate limiting, deterministic pagination, and bounded retention for item/finding history.

No participant notifications or email alerts are emitted. A separate operator alert destination, escalation policy, severity thresholds, and retention period require operations/security approval. Until approved, admin polling and sanitized worker/run health are sufficient; do not pretend an alert was delivered.

## Tests required for implementation

- Eligibility snapshot includes financial artifacts and missing-escrow statuses, excludes transactions added after the run cutoff, and remains deterministic across pages.
- Admin authentication/role/recent-TOTP, rate-limit denial, strict bounds, idempotency-key replay, safe summary serialization, and no participant notification.
- Concurrent run creation and duplicate item claims; expired lease recovery; multi-worker run/item lease winner; bounded continuation.
- Finding upsert deduplicates repeated codes; clean successful snapshot resolves findings; failed item does not resolve; out-of-order older snapshot cannot overwrite newer state.
- Operational tracking/audit transaction rollback and sanitized retry/exhaustion behavior.
- Isolated PostgreSQL tests with independent Prisma clients for run/item claim races, finding upsert/resolution races, restart/resume and concurrent financial posting during per-item read.
- Before/after assertions that transaction, escrow, payment attempt, escrow operation, journal and ledger-entry rows are unchanged by a full run.

## Smallest implementation sequence

1. Approve eligible-state set, initial batch bounds, finding retention, and whether summary-only reporting is sufficient.
2. Add the run/item/finding operational schema with an additive migration; validate on isolated `trustbridge_test` only.
3. Implement the bounded run service by composing the existing reconciler, with atomic leases, idempotency, findings, audit, and no financial writes.
4. Add an admin controller/routes with ADMIN, recent-TOTP, shared rate limit, strict validation, and summary-only responses.
5. Add a dedicated reconciliation worker/runner; do not attach full scans to every HTTP listener unless deployment explicitly accepts that model. Keep it separate from escrow provider execution.
6. Add focused unit/HTTP/PostgreSQL tests, prove financial-row non-mutation and worker recovery, then document operating cadence and runbook.

## Unresolved decisions

- Confirm the eligible-state set and whether captured-but-not-funded payment attempts should be candidates.
- Confirm default/max batch sizes, execution cadence, and who may continue partial runs.
- Confirm finding/audit retention and whether code/count-only findings meet operator needs.
- Confirm whether detailed finding reads need purpose-bound TOTP step-up beyond recent TOTP.
- Select the deployment scheduler/process role and restricted database grants for read-only financial access plus reconciliation-only writes.
- Confirm operator alert destination and escalation; no user-facing notification channel is acceptable for these findings.

## TB-BE-052C policy decision update (2026-11-12)

The project has approved the eligibility principle (relevant financial activity regardless of transaction state, with captured-but-not-funded as a distinct category), 100 default/500 maximum run limits, ADMIN-only manual execution and explicit ADMIN continuation of partial runs, step-up before detailed findings, and read-only financial behavior. The detailed decision record is in docs/TB-BE-052C_POLICY_DECISIONS.md.

These approvals supersede the corresponding open policy questions above. They do not prescribe the exact financial-activity query, a page size/retry/concurrency policy, a detailed-findings step-up purpose/freshness/resource binding, retention, alerts, scheduler deployment, or restricted database grants; those remain unresolved and must not be guessed.
