# TB-BE-052C-1 — Reconciliation Orchestration Implementation Readiness

**Assessment only.** No application, test, schema, migration, dependency, or database changes were made.

## Confirmed existing behavior

- src/services/ledger-reconciliation.service.js evaluates one transaction and its escrow, ledger accounts/entries, journals/entries, and escrow operations inside a PostgreSQL REPEATABLE READ transaction. It executes SET TRANSACTION READ ONLY, returns sorted discrepancy codes/counts, and maps database failures to a sanitized unavailable error. It does not read PaymentAttempt records.
- src/services/escrow.service.js exposes this evaluator as reconcileLedger; its separate reconcilePendingOperations method calls financial provider executors and is not suitable for batch scanning.
- The authoritative persisted records currently available are Transaction, PaymentAttempt, Escrow, LedgerAccount, LedgerJournal, LedgerEntry, and EscrowOperation in prisma/schema.prisma. The reconciliation evaluator directly validates the transaction/escrow/ledger/operation subset. Payment attempts are required to identify capture-only anomalies and are not currently part of the evaluator snapshot.
- src/services/payment.service.js marks provider-verified captures as CAPTURED and calls fundingService.recordVerifiedFunding in the same transaction (checkout verification around line 217; provider outcome processing around line 262). This existing coupling conflicts with the approved policy that capture must never be treated as escrow funding. It is a confirmed lifecycle conflict, not a reconciliation-query issue.
- src/services/escrow.service.js and src/services/notification.service.js use bounded candidate reads followed by updateMany conditional claims. A claim succeeds only when count === 1; processing/completion is bound to the lease owner. Notification retry uses exponential delay and terminates after eight attempts; escrow processing defers provider-pending outcomes and is not a suitable policy source for ledger-scan retry limits.
- src/middleware/auth.middleware.js builds request.auth from the signed JWT and persisted user/session state. src/middleware/recentMfa.middleware.js requires persisted TOTP_VERIFIED assurance for recent-TOTP checks; with a purpose it validates persisted purpose/resource/session/auth-version/enrollment bindings and consumes one-time grants atomically. src/services/step-up-purpose.registry.js is server-controlled and has no reconciliation-specific purpose.
- Existing admin routes use authentication, requireRole(ADMIN), five-minute recent-MFA middleware and shared rate limiting when configured (src/routes/admin.routes.js). There is no reconciliation route or batch service.
- LedgerReconciliationRun, LedgerReconciliationRunItem, and LedgerReconciliationFinding in prisma/schema.prisma provide run/item/finding status, timestamps, item ordinal, positive item/page bounds, unique run key, unique run/transaction and run/ordinal keys, finding identity, retry fields and run/item lease fields. The finding model stores only discrepancy code, lifecycle metadata and expected/observed counts.

## Recommended eligibility predicate

At the policy level, eligibility is:

E(transaction) = transaction exists at the run snapshot and there is relevant persisted financial-activity evidence for it in one or more of PaymentAttempt, Escrow, LedgerAccount, LedgerJournal/LedgerEntry, or EscrowOperation.

Transaction status is not an input to this predicate. This includes anomalous combinations such as financial records attached to CANCELLED or REJECTED transactions. Those are precisely cases a state allowlist could miss. The list above identifies the authoritative records available for review; it does not decide that every payment-attempt status is by itself qualifying financial activity. During implementation, derive the exact record/status/timestamp rules from the existing service semantics and review the resulting Prisma predicate against src/services/ledger-reconciliation.service.js. Do not invent that query here.

For the separate CAPTURED_NOT_FUNDED category, inspect captured attempts in the same read-only financial snapshot. A captured attempt is not funded merely because PaymentAttempt.status is CAPTURED, transaction status says FUNDED, or a provider reference exists. The candidate invariant to review is a persisted captured attempt with no matching successful EscrowOperation of type FUNDING linked by paymentAttemptId and no associated journal path that passes the existing evaluator's operation/journal/amount checks. Do not persist provider references or amounts in finding metadata. The evaluator needs a same-snapshot payment-attempt read/classification extension; querying attempts separately would create a race with the escrow/ledger snapshot.

### Confirmed conflict requiring resolution

The current capture path calls recordVerifiedFunding immediately, so the application presently treats verified capture as the trigger for internal escrow funding. Before implementing the approved distinct category as a trustworthy business result, reconcile this existing behavior with the approved capture/funding separation. The orchestration service must not compensate by suppressing or inventing a category, nor change payment or escrow behavior within this service task.

## Snapshot and pagination recommendation

1. Accept only a server-validated itemLimit of 100 by default and no more than 500. Reject caller values outside the approved range. The run record already persists the chosen bounds.
2. Create the run and its eligibility items atomically in a short PostgreSQL REPEATABLE READ transaction. Use one ordered candidate query (or bounded keyset reads in that same snapshot) with a deterministic unique ordering. A proposed ordering is (Transaction.createdAt, Transaction.id); confirm that ordering and cutoff semantics against the final eligibility predicate. Read at most itemLimit + 1; persist no more than itemLimit transaction IDs and set hasMore/cursor when the extra row exists. This keeps snapshot materialization bounded without holding the transaction open while items are evaluated.
3. Persist only run ID, transaction ID, stable ordinal and operational timestamps in run items. Do not persist terms, user data, payment references, or financial amounts.
4. Process persisted items in bounded pages using (runId, ordinal) and the configured pageSize. No page-size value has been approved; require a finite validated service configuration no greater than the run limit rather than silently adopting the earlier provisional value of 20.
5. Each item evaluation must call the existing per-transaction read-only evaluator, extended to read captured attempts within that same repeatable-read snapshot if implementing the captured-not-funded category. Write item/finding outcomes only after that read-only transaction has completed.

## Claim, lease, retry, and completion recommendation

- Claim a run with a conditional updateMany on eligible run state and absent/expired leaseExpiresAt; assign a fresh random lease owner and finite expiry. Continue only on exactly one updated row.
- Claim one item at a time (or a bounded page, each conditionally) where status is PENDING and retry time is due, or status is PROCESSING with an expired lease. Set PROCESSING, owner, claimed time, expiry, and increment attemptCount; exactly one affected row is the claim. A run lease serializes orchestration; item claims remain a second defense against duplicate work.
- All completion/checkpoint updates must include id, PROCESSING, and the same lease owner. A zero-row update means ownership was lost: do not write a finding or increment counters. Renew leases conditionally if an evaluator can exceed the lease duration.
- Retry only the evaluator's sanitized transient-unavailable result and explicitly classified transient database failures. Store an allowlisted error code only. Do not persist exception text. Require an injected finite retry ceiling/backoff; no scan retry ceiling has been approved. Once exhausted, mark the item FAILED, never CONSISTENT, and leave existing findings unresolved.
- Persist an item terminal state and finding upsert/resolution atomically in an operational-only transaction after evaluation. Count terminal states from run items (or update counters only under the run lease and item-owner condition) to avoid duplicate count increments.
- Recommend COMPLETED only when all frozen items are successfully evaluated (CONSISTENT or DISCREPANCY) and the snapshot has no continuation. PARTIAL represents exhausted/unfinished items or candidates beyond the bound. FAILED is reserved for run-level setup/persistence failures, not a transaction discrepancy. Empty snapshots may complete with zero counts.
- A successful clean item may resolve its finding; failed or unknown items must never resolve findings. Preserve ordering so an older observation cannot overwrite a newer one; use an observation timestamp/version consistently and test competing runs.

### Partial-run boundary still unresolved

The approved rule requires an explicit ADMIN action to resume a partial run, while the run is capped at 500 and the design freezes the item set. The existing schema can resume failed/unprocessed items already frozen in the run. It cannot persist more than 500 items in that run, and it has no parent/continuation-run relation. Decide whether reaching the 500-candidate cap requires a new explicitly initiated run with a fresh snapshot or a linked continuation run and what snapshot semantics that continuation represents. Do not exceed 500 items or silently resume automatically.

## MFA and detailed findings

**Reusable now:** authentication and active-session checks, role authorization, the existing five-minute ADMIN recent-TOTP route pattern, and purpose-bound step-up middleware backed by persisted TOTP_VERIFIED assurance. Recovery-code assurance is rejected by the recent-TOTP middleware.

**Not reusable as-is:** no registered purpose represents reading detailed reconciliation findings. Existing purposes bind different resource types and operations; do not borrow DISPUTE_REVIEW, ESCROW_REFUND, or another unrelated purpose. Approval is still required for the reconciliation-specific purpose name, whether the grant is one-time, the resource binding (run ID or another scope), and freshness window. Until decided and registered server-side, detailed finding reads must not be exposed. The orchestration service itself should not treat a caller-supplied role or assurance string as proof of authorization.

## Minimum database permissions

For the orchestration data path, a restricted runtime role should have:

- SELECT on transactions, payment_attempts, escrows, ledger_accounts, ledger_journals, ledger_entries, and escrow_operations.
- SELECT, INSERT, and UPDATE on ledger_reconciliation_runs, ledger_reconciliation_run_items, and ledger_reconciliation_findings; no DELETE is needed for this scope.
- INSERT on audit_logs only if the selected run/finding audit events are written by this service.
- No INSERT, UPDATE, or DELETE on financial/transaction tables; no provider, notification, or outbox write permission.

An ADMIN HTTP route also needs the existing authentication/session/MFA reads (users, refresh_tokens, user_mfa, mfa_challenges) and shared rate-limit service access. The repository currently uses the normal Prisma application client; no reconciliation-only runtime role or grant composition was verified. Do not change roles or grants in this assessment.

## Focused test plan

### Unit

- Eligibility predicate includes every persisted financial-activity source for arbitrary transaction states and excludes rows after the fixed cutoff.
- Captured-but-not-funded is distinct; capture alone never produces a funded classification; a linked successful funding operation and valid journal are checked through the evaluator.
- Default 100, maximum 500, rejection above 500, finite configured page/retry bounds, deterministic (createdAt,id) ordering, and continuation marker behavior.
- Duplicate idempotency key returns one run without duplicate items; failure to reconcile never becomes consistent.
- Conditional item/run claim, owner-only completion, expired-lease reclaim, retryable versus terminal error, and run status/counter aggregation.
- Finding identity upsert, successful clean resolution, failed-item non-resolution, and out-of-order observation protection.
- Safe persisted fields and no calls to payment, escrow mutation, transaction transition, journal, notification, or provider services.

### PostgreSQL integration

Use only identity-preflighted isolated trustbridge_tb050_clean, migrations current, and two independent Prisma clients:

- Concurrent run creation with the same idempotency key yields one run and one eligibility snapshot.
- Candidate snapshot is bounded at 100/500, stable across ordering ties, honors cutoff, and stores each eligible transaction once.
- Concurrent run and item claims yield exactly one lease owner; expired leases permit one reclaim; stale owners cannot checkpoint.
- Concurrent duplicate discrepancy persistence yields one finding; older observations cannot replace newer state; failed/unknown evaluations do not resolve findings.
- Retry/terminal transitions and run completion are atomic with item/finding changes.
- Injected failures roll back operational checkpoints. Before/after counts and selected identifiers for transactions, payment attempts, escrow, operations, journals and entries remain unchanged by orchestration.
- Verify no PostgreSQL test contacts payment providers, participant notification, or operator alert systems.

## Readiness conclusion

**Core run/item orchestration can be designed against the approved policy, but implementation should wait on two blocking technical resolutions:** (1) reconcile the existing capture-triggered escrow funding behavior with the approved capture/funding separation and define the resulting CAPTURED_NOT_FUNDED invariant; (2) decide whether a capped partial run resumes only its already-frozen items or creates a linked continuation snapshot. Also resolve a finite page/retry configuration before production execution. The purpose-specific MFA decision blocks detailed-finding exposure, but not the internal evaluator or summary-only run processing.

No route, controller, scheduler, worker, role/grant, provider, or automatic repair is included in the orchestration service stage.
