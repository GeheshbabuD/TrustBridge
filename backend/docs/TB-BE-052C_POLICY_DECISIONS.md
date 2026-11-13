# TB-BE-052C — Reconciliation Orchestration Policy Decisions

**Status:** Approved project policy recorded; service implementation remains pending.
**Approved:** 2026-11-12

This document resolves the orchestration policy decisions listed in the TB-BE-052A design, within the scope below. It does not define a financial-activity query or an MFA purpose implementation.

## Approved decisions

1. **Eligibility is based on relevant financial activity, not a transaction-state allowlist.** Include transactions with relevant financial activity regardless of current transaction state. The exact authoritative records and Prisma predicate must be derived during implementation and reviewed against the existing read-only reconciliation service. Do not use a fixed status allowlist as the sole eligibility rule.
2. **Captured but not funded is a distinct reconciliation category.** Payment capture is not proof of escrow funding. The category must be represented in operational reconciliation results without conflating payment and escrow state.
3. **Batch limits:** default run size is 100 transactions; maximum is 500 transactions per run. These are run limits; they do not define a worker page size.
4. **Partial runs:** resumption is allowed only after an explicit ADMIN action. A run must not resume itself or be continued automatically.
5. **Operational ownership:** only ADMIN-triggered manual runs are in scope. No scheduler or recurring automatic execution is permitted in this implementation phase.
6. **Detailed findings:** require step-up authentication before exposure. Implementation must use existing server-side MFA and assurance validation; client-supplied assurance is never trusted.
7. **Financial safety:** reconciliation is read-only with respect to financial and transaction records. It must not repair or mutate ledger/journal, payment, escrow, or transaction state.

## Implementation constraints and unresolved details

- The approved eligibility policy does not prescribe a query. Implementation must identify relevant financial activity from existing authoritative persisted records, handle captured-but-not-funded as its own category, and test the predicate against the current per-transaction reconciler. Do not infer funding from capture or infer eligibility only from state.
- The approval to step up for detailed findings does not specify a purpose key, freshness window, or resource binding. Reuse existing server-side step-up mechanisms and resolve any purpose-specific authorization configuration before exposing detailed findings. Summary access must not be treated as permission for detailed financial data.
- The approved default and maximum run sizes do not approve a page size, retry ceiling/backoff, or worker concurrency. Those operational mechanics must be bounded and justified in implementation without exceeding 100 by default or 500 maximum for a run.
- Finding contents remain limited to stable discrepancy codes and the minimum approved count/lifecycle metadata. No balance amounts, PII, evidence, provider payloads, or arbitrary diagnostic objects are approved.
- Retention duration, alert destination/escalation, scheduler ownership, and restricted database-role deployment remain unapproved. This phase must not add retention/purge behavior, alerts, or scheduled execution.

## Acceptance checks for the service stage

- Snapshot candidate IDs from authoritative financial activity at a fixed run cutoff, in deterministic order, within the approved batch limit.
- Treat captured-but-not-funded separately from escrow funding and never convert capture into a funding result.
- Require explicit ADMIN authorization for manual creation and partial-run continuation; require existing server-side step-up for detailed findings.
- Use database idempotency and conditional leases for safe retries and competing requests.
- Invoke only the existing per-transaction repeatable-read, read-only reconciliation evaluator.
- Persist only run/item/finding operational metadata; never update financial or transaction records.

The persistence foundation in TB-BE-052B supplies storage but does not implement these policies or authorization gates. TB-BE-052 remains IN PROGRESS.
