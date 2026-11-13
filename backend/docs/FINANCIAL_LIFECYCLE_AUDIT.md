# TB-BE-049 — Financial Lifecycle and Ledger Consistency Audit

**Assessment:** Focused source-and-test review; read-only. No application/schema/migration changes, database operations, provider calls or tests were run for this audit. Test references below identify existing coverage; historical results are cited only where recorded in the development log.

## Summary

The code separates payment attempts, transaction states, escrow operations, disputes and ledger journals. Transaction-row locking, persisted provider evidence checks, operation idempotency, execution leases, one-time TOTP authorization, immutable balanced journals and dispute guards provide substantial protection against duplicate or unauthorized operations. The principal financial-policy gap is that verified **capture** currently posts escrow funding and makes the transaction `FUNDED`; no general payment-settlement evidence is ingested before release becomes eligible. This conflicts with the unresolved capture-versus-settlement policy and prevents a claim that the internal escrow balance reflects settled or held funds.

## Lifecycle observed

| Domain | Current states / transitions | Evidence and serialization |
|---|---|---|
| Payment attempt | `CREATED → PENDING → CAPTURED`, `FAILED` or `CANCELLED`; terminal conflicts are not silently overwritten. | Initiation, callback, reconciliation, webhook and cancellation serialize on the transaction row. Capture requires signed callback plus provider fetch, or verified raw-body webhook / authoritative status lookup, with persisted order, payment reference, amount and currency matching. |
| Transaction | `CREATED → ACCEPTED/REJECTED/CANCELLED`; `ACCEPTED → AWAITING_PAYMENT`; `AWAITING_PAYMENT → FUNDED/CANCELLED`; later delivery, dispute, release/refund-pending and final states are handled by dedicated services. | Expected-version updates and status-history records are transactional. Cancellation after payment initiation requires terminal failed/cancelled attempts plus verified final no-capture evidence. |
| Escrow | `UNFUNDED → FUNDED → RELEASE_PENDING/REFUND_PENDING → RELEASED/REFUNDED`; partial refund returns escrow to `FUNDED`. | Capture invokes `recordVerifiedFunding` in the payment transaction. Release/refund authorization and provider execution are separate; completion requires a matching verified executor result and commits journal, escrow, transaction history and audit atomically. |
| Dispute | `OPEN → UNDER_REVIEW → RESOLVED → CLOSED`; resolution is `REFUND`, `PARTIAL_REFUND` or `SELLER_RELEASE`. | Transaction lock serializes dispute creation/resolution with escrow transitions. Admin resolution uses authenticated TOTP-protected routes. Release is blocked by active disputes; refunds require resolved refund authorization. |

## Findings

### HIGH — Capture currently establishes internal escrow funding without settlement evidence

`src/services/payment.service.js` calls `recordVerifiedFunding` on capture from callback, reconciliation and webhook paths. `src/services/escrow.service.js` records `VERIFIED_PROVIDER_CAPTURE`, posts `PROVIDER_CLEARING` debit / `ESCROW_LIABILITY` credit, and moves escrow and transaction to `FUNDED`. Release authorization checks funded escrow, delivery acceptance and dispute state; `src/services/razorpay-escrow.executor.js` additionally requires the specific Route transfer to be `processed` and `settled`, but that is recipient-transfer evidence, not general merchant settlement. `src/services/razorpay-payment.adapter.js` normalizes payment events and does not ingest general settlement allocations.

**Risk:** Internal release eligibility may precede a verified merchant settlement allocation. This does not prove custody or that provider-clearing funds reached TrustBridge. Do not enable production release based on capture alone. Resolve policy/accounting and account-specific Razorpay evidence first, then introduce a separately persisted settlement gate and additive treatment for existing funded records.

### MEDIUM — No general settlement, chargeback or post-capture reversal reconciliation

The payment attempt enum has no settlement/reversal state and adapter normalization covers payment authorization, capture and failure. The explicit refund flow is tracked as an escrow operation, but no general settlement/chargeback/reversal evidence workflow reconciles unexpected provider adjustments against already funded escrow. The Route adapter exposes a reversal operation, but it is not wired into escrow execution or a compensating ledger workflow.

**Risk:** Delayed or contradictory provider adjustments can leave internal balances and external provider records divergent. Add a durable exception/reconciliation path with authoritative evidence and human review; never auto-reverse or rewrite posted entries.

### MEDIUM — Escrow balance is a transactional projection, not a database-enforced ledger invariant

The application updates `Escrow.balanceMinor` and status in the same transaction as journal posting, under transaction locks. The migration enforces balanced journals and immutable posted journals/entries. It does not enforce that escrow balance/status equals the ledger-derived outstanding liability, nor that every operation status agrees with the transaction and journal state.

**Risk:** A future writer or operational repair can cause projection drift despite normal-service controls. Add periodic reconciliation and alerting; consider constrained database privileges and explicit invariant checks. No evidence of ordinary service paths creating unbalanced journals was found.

### MEDIUM — Reversal lineage is modeled but unused by posting code

`LedgerJournal.reversalOfJournalId` has a restrictive composite relation, but the `postJournal` helper in `src/services/escrow.service.js` never sets it. Funding, release and refund journals are connected through operations and operation IDs, but there is no direct journal reversal link for compensating adjustments.

**Risk:** Financial history is immutable and balanced, but audit lineage for a future reversal/chargeback is less direct. Before implementing reversals, require an explicit source-journal link, uniqueness/partial-reversal semantics and a balanced compensating entry.

### LOW — Repeated webhook identity with conflicting content is not visibly quarantined

Webhook event identity is persisted uniquely and duplicate processing does not create another capture/funding posting. The reviewed duplicate path recognizes an existing event ID; source review did not find a comparison of the stored event's canonical normalized content against a repeated event using that same ID.

**Risk:** No second posting is expected, but provider-ID equivocation or data inconsistency may be acknowledged without a discrepancy record. Compare an integrity digest/normalized identity and quarantine conflicting duplicates.

### MEDIUM — Partial-refund terminal status and dispute closure semantics need explicit review

On a successful partial refund, escrow remains `FUNDED`, transaction returns to `DELIVERED`, and the resolved dispute is not closed by the finalization branch (closure is only run for non-partial operations). This may be intentional to preserve the remaining balance, but the model does not document whether additional dispute decisions/refunds are allowed or how the residual obligation is resolved.

**Risk:** A resolved dispute can remain open in lifecycle terms while the transaction resumes ordinary delivery status. Specify and test whether the dispute should close, remain resolved with a residual amount, or require a new case before enabling partial refunds.

## Verified safeguards

- Payment references, persisted order, amount and currency are matched before capture is accepted; invalid callback signatures and webhook signatures do not establish success.
- Cancellation cannot win concurrently with payment initiation/capture because both serialize on the transaction row; cancellation requires verified terminal no-capture evidence after payment attempts exist.
- Escrow funding is idempotent per payment attempt (`EscrowOperation.paymentAttemptId` and `operationKey`) and transaction-serialized.
- Release requires participant-based buyer authority, delivery acceptance (or reviewed seller-release resolution), active funded escrow, no active dispute and fresh TOTP step-up. ADMIN does not acquire transaction ownership.
- Refund requires administrator authority, fresh TOTP and a persisted resolved refund decision; partial refund amount must be less than remaining escrow balance.
- Provider execution is lease-claimed; ambiguous outcomes remain pending. Ledger/state finalization requires a matching verified result and is atomic with history/audit.
- Journals use positive BigInt minor units and one currency; service checks balance. PostgreSQL deferred constraint triggers require at least two balanced entries; mutation triggers reject journal/entry update and delete.
- Unique operation, payment, event and idempotency keys plus conditional status/version updates protect duplicate actions.

## Test evidence and limits

Existing evidence includes `tests/unit/payment-service.test.js`, `tests/unit/razorpay-payment.adapter.test.js`, `tests/unit/escrow-ledger.test.js`, `tests/unit/razorpay-escrow.executor.test.js`, `tests/integration/escrow.test.js`, `tests/integration/dispute.test.js`, `tests/postgres/payment-concurrency.integration.test.js` and `tests/postgres/escrow-ledger.integration.test.js`. These cover provider mismatch/signatures, duplicate and out-of-order events, funding idempotency, executor leases, ledger balance/immutability, rollback, participant/admin checks and payment/cancellation concurrency.

The development log records the isolated PostgreSQL payment concurrency suite passing **6/6** and full suite **389 passed, 0 failed, 9 skipped** during TB-BE-048; those results were not rerun for TB-BE-049. The prior escrow ledger integration results are recorded there, but this audit did not execute tests. Dedicated PostgreSQL coverage for dispute-versus-release races, post-capture reversal reconciliation, conflicting duplicate event IDs, ledger-to-escrow projection drift and partial-refund dispute semantics was not established by the inspected test evidence.

## Recommended fix order

1. Obtain product/finance/legal/compliance and account-specific provider decisions on settlement finality and escrow accounting; keep live financial execution disabled meanwhile.
2. Design additive settlement allocation/evidence records and a backward-compatible treatment for existing capture-funded escrow; gate release on approved evidence.
3. Add authoritative adjustment/chargeback/reversal reconciliation with compensating journals and human review; wire Route reversal only under a separately approved policy.
4. Specify partial-refund dispute/residual-balance lifecycle and add two-client PostgreSQL races for dispute/release/refund transitions.
5. Add periodic ledger-versus-escrow reconciliation and alerting, plus conflicting-webhook-ID quarantine tests.

KYC and wallet remain blocked and are outside this audit. No financial or deployment readiness is claimed.
