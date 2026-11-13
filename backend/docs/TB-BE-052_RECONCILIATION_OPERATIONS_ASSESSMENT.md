# TB-BE-052 — Operational Escrow Reconciliation Assessment

**Status:** Assessment only; no implementation or database work performed.

## Current implementation

- `src/services/ledger-reconciliation.service.js` evaluates one transaction at a time. It reads a consistent PostgreSQL `REPEATABLE READ` snapshot and starts it with `SET TRANSACTION READ ONLY`. It returns deterministic balance/count/status fields and discrepancy codes; database failures map to a sanitized unavailable error. It does not persist reports or write financial records.
- `src/services/escrow.service.js` exposes `reconcileLedger({ transactionId })`. Its `reconcilePendingOperations()` is a different function: it retries/reconciles pending provider release/refund operations, and must not be repurposed as a ledger scan.
- `src/workers/escrow-outbox.worker.js` is a supervised timer for the financial-operation outbox and provider reconciliation. `src/server.js` starts it when the application listener comes up; `src/services/escrow-runtime.composition.js` enables it only with configured/approved financial executors. It is not a general ledger-reconciliation worker. `docs/DEPLOYMENT_GUIDE.md` confirms there is no separate worker-process command today.
- `src/services/notification.service.js` has leased, retryable outbox delivery and recipient-deduplicated in-app notifications. The notification templates and routes are transaction/user-facing; no operator recipient, operational alert adapter, or reconciliation finding type exists. `AuditLog` is append-oriented event metadata, not a deduplicated current-finding store.
- `src/app.js` and `src/server.js` report sanitized worker lifecycle state through readiness/status callbacks. This exposes worker state and last failure codes, not discrepancy counts or a reconciliation run history.
- `tests/unit/ledger-reconciliation.test.js`, `tests/postgres/ledger-reconciliation.integration.test.js`, and `tests/postgres/escrow-ledger.integration.test.js` cover deterministic discrepancy evaluation, read-only transaction setup, snapshot visibility during concurrent financial posting/rollback, test-owned funding/release/refund flows, and non-mutation checks. `tests/unit/escrow-outbox.worker.test.js` covers bounded worker ticks and draining. There is no batch-scan, finding-persistence, operator-trigger, or operational-alert test.

## Smallest safe design

### 1. Scheduled and manual execution

Create a separate `ledger-reconciliation-operations.service.js` over the existing per-transaction reconciler. It should enumerate a bounded, deterministic keyset of eligible transaction IDs (financial/escrow-bearing records plus statuses for which a missing escrow is a discrepancy), then invoke the existing per-transaction read-only service. A run should have a fixed creation-time cutoff, cursor, page size and maximum-record limit; persist progress between pages rather than holding a long transaction. Every item keeps the existing per-transaction repeatable-read snapshot guarantee. A failed item is recorded as failed/unknown and must never be counted as consistent.

Prefer one-shot scheduled execution by a deployment scheduler and an operator-invoked one-shot command using the same service. This avoids starting a full scan on every HTTP replica and does not overload the escrow financial-operation worker. No public unauthenticated route is appropriate. If an HTTP trigger is later required, it needs a separately approved ADMIN/recent-TOTP authorization contract, shared rate limit, asynchronous run ID response, and a summary-only status endpoint; it must not return account-wide balances or detailed findings to ordinary participants. Hosting/scheduler choice remains open.

### 2. Persistent runs and findings

Current schema does not represent reconciliation runs or discrepancies. `OutboxEvent` can lease and retry an event, and `AuditLog` can record an immutable event, but neither provides a deduplicated current finding state, run cursor/completion, or resolution lifecycle. Reusing either as a finding table would lose those semantics or create duplicate alert events.

If operational history is required, the minimum durable extension is additive:

- `LedgerReconciliationRun`: idempotency/run key, trigger type, state (`QUEUED`, `RUNNING`, `COMPLETED`, `PARTIAL`, `FAILED`), cutoff/cursor, scanned/consistent/discrepant/failed counts, timestamps, bounded lease owner/expiry, and sanitized last error code.
- `LedgerReconciliationFinding`: transaction ID, stable discrepancy code, active/resolved state, first/last-seen timestamps, occurrence count, first/last run references, and only allowlisted comparison metadata needed by operators. Enforce uniqueness for the active finding identity, such as transaction plus discrepancy code; close a finding only after a successful clean scan of that transaction. Preserve finding lifecycle changes in `AuditLog`.

Do not store raw Prisma errors, provider payloads, evidence, user PII, credentials, or arbitrary reconciliation objects. Numeric balance snapshots are financially sensitive; product/security should approve whether they are stored or whether code/count-only findings are sufficient. Additive migration review and isolated-test-database verification would be required in a later implementation task.

### 3. Retry, idempotency and concurrency

- Give each scheduled window or manual invocation a unique idempotency key; duplicate submission returns the existing run rather than creating competing scans.
- Use a database lease/conditional claim on the run row with expiry so multiple application/job instances cannot advance the same cursor concurrently. Expired leases permit safe resume. Keep page and per-item operations bounded.
- Reconcile an item read-only first; persist only operational run/finding metadata afterward in a separate transaction. Upsert findings by stable identity so reruns do not duplicate an active discrepancy. A failed/partial run never resolves findings it did not successfully revisit.
- Retry transient database failures with a bounded exponential delay and sanitized reason code. Stop/release the lease on cancellation; resume from the last durable cursor. Mark exhausted or malformed work `PARTIAL`/`FAILED`, not healthy.
- Existing notification/outbox leases and unique event keys are suitable for delivering an already-produced alert event, but not for serializing a whole scan unless the scan run itself is persisted. Do not let this worker invoke payment, release, refund, ledger, or transaction-state services.

### 4. Privacy-safe alerts

Do not notify transaction participants about internal accounting discrepancies. Existing `USER_NOTIFICATION` templates are not an operations channel. The safe initial output is a structured, sanitized run summary containing run ID, status, aggregate counts and stable error codes; emit no PII, evidence, provider references or raw query errors. Persist delivery intent in the outbox only after an approved operator destination and consumer exist. Provider-neutral alert adapter/monitoring integration, recipient ownership, severity thresholds, deduplication window and escalation policy need an operations decision. Until then, expose findings only through a restricted operator mechanism and readiness/worker health should report failure state without leaking details.

### 5. Financial write protection

Keep the existing reconciler as the only source of financial snapshots; do not add writes to `Transaction`, `Escrow`, `LedgerJournal`, `LedgerEntry`, or `EscrowOperation`. Run tracking/finding writes must target only the new operational tables and append-only audit events. Preserve `SET TRANSACTION READ ONLY` and `REPEATABLE READ` for each financial snapshot. For defense in depth, run the scanner with a database role that has SELECT on required financial tables and narrowly scoped writes only to reconciliation metadata/audit/outbox; do not reuse a privileged financial executor credential if deployment composition can separate it. No automatic repair or mutation of accounting state is permitted.

## Affected files for a future implementation

- Service and scanner: `src/services/ledger-reconciliation.service.js` (reuse only), new `src/services/ledger-reconciliation-operations.service.js`.
- Worker/entry point: new `src/workers/ledger-reconciliation.worker.js` and a supervised one-shot command or scheduler composition point; avoid adding it to every HTTP replica without a shared run lease.
- Persistence: `prisma/schema.prisma`, an additive migration, generated Prisma client, and audit/outbox composition only if persistent runs/findings are approved.
- Optional restricted API: admin route/controller/validator only if operations approves HTTP triggering and report access.
- Tests: new unit tests; HTTP auth/rate-limit tests if an endpoint is approved; isolated PostgreSQL tests for lease races, resumption, duplicate run requests, finding upsert/resolution, partial failure and proof that financial rows remain unchanged.
- Documentation: deployment/operations runbook, database design, security plan, testing plan and progress report after implementation evidence exists.

## Decisions and approvals needed

1. Who owns the reconciliation schedule and may launch manual runs: deployment operator, ADMIN with fresh TOTP, or both?
2. What transaction population and scan frequency are required, and what maximum run/page budget is acceptable?
3. Are durable discrepancy/finding records required, and may they store sensitive numeric balances?
4. Which operator alert destination is approved, with what severity, dedupe/cooldown and escalation policy?
5. Can deployment provide a restricted database role for financial SELECT plus reconciliation-only writes, and a separate scheduled-job process role?

Until these are decided, the safe next step is to approve the scope and data-retention contract; do not add a public endpoint, participant notification, persistent findings schema, or scheduled full scan by assumption.
