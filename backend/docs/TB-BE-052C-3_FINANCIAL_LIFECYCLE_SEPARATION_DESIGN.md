# TB-BE-052C-3 — Payment Capture and Escrow Funding Separation

**Status:** Design only. No application, schema, migration, test, provider, or database changes were made. This document proposes a future lifecycle; it does not approve accounting policy, provider capability, custody, or production financial execution.

## 1. Verified current behavior

`src/services/payment.service.js` verifies capture through signed checkout plus server-side payment fetch, provider status reconciliation, or a signature-verified webhook. It matches the persisted attempt/order/payment references, amount, and currency, then persists `PaymentAttempt.CAPTURED`. Each capture path also calls `recordVerifiedFunding` in the same transaction.

`src/services/escrow.service.js:recordVerifiedFunding` trusts that captured state; it does not independently fetch or verify settlement evidence. It creates a successful `EscrowOperation(FUNDING)`, posts equal integer-minor debit/credit entries (`PROVIDER_CLEARING` / `ESCROW_LIABILITY`), marks `Escrow` and `Transaction` funded, and writes history/audit/outbox records. The funding operation is idempotent and runs under transaction-row serialization. `PROVIDER_CLEARING` is internal bookkeeping, not provider settlement evidence or proof of legal custody.

The current `PaymentAttemptStatus` is `CREATED`, `PENDING`, `CAPTURED`, `FAILED`, or `CANCELLED`. `PaymentAttempt` stores the captured payment reference. Existing escrow, operation, journal, and entry models are separate, and journal entries use integer minor units. There is no persisted general payment-settlement allocation/evidence lifecycle in the inspected schema or adapter. Razorpay payment order/fetch/signature/webhook and status-query capabilities exist; settlement event/report/API details and account access remain unverified. Route transfer `processed` plus recipient `settled` is specific to that seller transfer and is not general merchant payment-settlement evidence.

Existing tests verify and intentionally assert capture-triggered funding and its atomic/idempotent ledger effects, including `tests/unit/escrow-ledger.test.js`, `tests/postgres/escrow-ledger.integration.test.js`, and `tests/postgres/payment-concurrency.integration.test.js`. They do not verify capture/funding separation.

This is a confirmed policy conflict: approved reconciliation policy says capture is not escrow funding, while current runtime treats capture as sufficient to fund internal escrow. Do not resolve it by silently changing current behavior or by describing the existing journals as settlement-proven.

## 2. Proposed future event lifecycle

Payment, settlement, escrow funding, and seller payout remain distinct records and state machines. Exact enum/state additions require separate approval and schema review.

| Event | Proposed transition | Minimum authoritative evidence | Financial effect |
|---|---|---|---|
| Order/initiation | Existing attempt `CREATED` → `PENDING` | Persisted attempt and order reference; server-side provider response matched to internal attempt | No escrow funding or ledger posting solely from order creation |
| Payment capture | `CREATED`/`PENDING` → `CAPTURED` | Verified raw-body webhook or authenticated provider fetch/status result; exact provider account, payment/order references, integer amount and currency match | Persist capture provenance and attempt state only. Do not set escrow/transaction funded and do not create a funding journal |
| Settlement evidence receipt | Proposed independent settlement record: unobserved → pending/needs review | Verified provider-account-scoped event or authenticated report/API ingestion; stable settlement and payment-allocation identifiers, provenance/integrity, effective/received times | Persist normalized evidence/inbox identity only; receipt alone does not post escrow funding |
| Settlement reconciliation | Proposed evidence: pending → partial, matched/eligible, failed, reversed/adjusted, or reconciliation-required, subject to approved vocabulary | Authenticated/signed evidence; exact link to captured attempt/order; allocation-level amount/currency and batch totals reconcile; duplicates/conflicts checked; authoritative finality threshold approved | No posting until finance policy defines recognition point and treatment of gross/net, fees and adjustments |
| Internal escrow funding | Unfunded → funded only under an approved funding policy | Matched capture plus independently verified settlement evidence if that is the approved trigger; policy-authorized allocation and transaction lock; no conflicting refund/reversal/chargeback | One idempotent, balanced, immutable journal and linked funding operation; transaction/escrow state and history update atomically. Accounting accounts/timing remain for finance approval |
| Seller release/payout | Existing separately authorized release workflow → pending → final outcome | Existing participant/business authorization and fresh TOTP controls, server-resolved Route recipient, idempotent operation, provider result matched to payment/transfer/account/amount/currency; final recipient-transfer evidence | Route transfer is separate from funding. Finalize release accounting/status only on verified matching final outcome; capture or merchant settlement alone never authorizes payout |
| Refund/reversal/chargeback | Separate operation/evidence lifecycle; never regress or overwrite capture history | Provider-verified refund, settlement correction, reversal, or chargeback linked to the exact payment/allocation; authorization and reconciliation | Append compensating entries only under approved accounting rules; never edit posted entries. Pending/ambiguous results remain pending/review-required |

No timeout, missing webhook, browser redirect, client claim, transaction status, AI result, blockchain record, or locally assigned terminal label establishes payment failure, settlement, funding, or payout finality.

## 3. Accounting invariants

- Capture evidence, settlement evidence, internal escrow obligation, and seller transfer are separately identified; none substitutes for another.
- Never create an escrow funding journal merely because an attempt is captured. Do not count provider clearing, a settlement batch aggregate, or escrow liability as a user's wallet balance or as proof of custody.
- Once finance approves recognition, each journal must balance in integer minor units and currency before commit, use immutable entries, and be linked idempotently to the exact approved funding allocation. Fees, taxes, gross/net differences, holds, partial allocations, and adjustments require explicit accounts and posting rules; this design does not choose them.
- One capture/allocation cannot fund multiple escrow obligations. Enforce unique source/allocation identity and transaction-first locking with stable subsequent lock ordering across capture, settlement ingestion, funding, cancellation, refund, and release finalization.
- Refunds, reversals, and chargebacks are new evidence and compensating operations, never edits to historical journals. An ambiguous provider result must not cause a blind retry that can duplicate movement.

## 4. Captured but not independently funded

Under the proposed separation, a verified capture may exist while no eligible settlement/funding evidence exists. Keep the attempt captured and record this as a distinct operational/reconciliation condition. Do not create `FUNDING`, a funding journal, a positive funded escrow balance, `Escrow.FUNDED`, or `Transaction.FUNDED` from capture alone. Keep the operation ineligible for release.

Cancellation must remain blocked while capture is present or payment outcome is ambiguous. The current transaction cancellation guard is intentionally conservative; separation must not turn capture into a cancellable no-payment outcome. Product must approve customer-visible payment-versus-escrow states and the meaning/API treatment of `AWAITING_PAYMENT` when capture exists but funding does not. Do not infer a provider failure from elapsed time.

## 5. Historical compatibility

Preserve all existing `PaymentAttempt`, `EscrowOperation`, journal/entry, escrow, transaction, status-history, audit, and outbox records exactly. In particular, legacy funding operations with reason `VERIFIED_PROVIDER_CAPTURE` describe the existing capture-triggered internal posting; they are not evidence of provider settlement. Do not bulk relabel, delete, reverse, or recreate historical journals, and do not retrospectively infer settlement from `FUNDED` state or the `PROVIDER_CLEARING` account.

Future readers and reconciliation must distinguish legacy capture-triggered funding from new settlement-evidenced funding without rewriting old rows. Any new evidence provenance must be additive and explicit. Before rollout, finance/product must decide how already-funded transactions and open release/refund operations are governed; an identified discrepancy requires separately approved, audited compensating treatment, never an automatic migration repair.

## 6. Idempotency, concurrency, and event integrity

Reuse the existing transaction-row lock as the first lock for all operations that can affect a transaction's payment/funding/release/cancellation eligibility. Then lock affected attempts and settlement/allocation, escrow/operation, and journal records in a single documented order. Apply state/evidence changes and any approved journal/history/audit writes atomically. Keep provider network calls outside database transactions; persist an idempotent operation/lease before calls and reconcile ambiguous responses before retry.

Deduplicate signed webhook inbox events by provider account scope and event identity, and independently deduplicate settlement allocations by stable provider settlement-line/payment identity. Identical redelivery is an idempotent no-op. Same identity with different content is quarantined and cannot overwrite accepted evidence. Out-of-order capture, settlement, refund, and reversal messages are checked against persisted evidence and allowed transitions; retain original events and require reconciliation for contradictions. Verify webhook signatures over the unmodified raw body before creating trusted events. Report and ingestion paths require authenticated provider retrieval and integrity/provenance checks.

## 7. Reconciliation after separation

Use the approved eligibility rule: include transactions with relevant persisted financial activity regardless of transaction state, derived from authoritative records in one fixed, read-only snapshot. The current candidate records are `PaymentAttempt`, `Escrow`, `LedgerAccount`, `LedgerJournal`, `LedgerEntry`, and `EscrowOperation`; a future settlement evidence/allocation record must join that same snapshot. Do not use a transaction-state allowlist as the eligibility predicate.

Classify at least these concepts separately in evaluation: (a) captured attempt with no matching valid internal funding operation/journal, and (b) provider settlement evidence that is unmatched, partial, contradictory, reversed, or policy-ineligible. A valid legacy funding operation proves only that the current internal posting exists; it does not prove settlement. Capture, `Transaction.FUNDED`, or a provider reference alone proves neither. A future “settlement confirmed” result requires the approved evidence contract and allocation checks. Batch reconciliation remains read-only and must not repair or mutate payment, escrow, transaction, or ledger state. Detailed findings remain behind the approved server-side step-up authorization.

## 8. Adapter and provider boundary

The existing Razorpay adapter supports order creation, payment retrieval/verification, payment status lookup, signed payment-event verification/normalization, refund operations, and Route transfer operations under explicit authorization gates. It does not currently ingest or normalize general merchant settlement allocations or establish a settlement-finality contract for the TrustBridge account. Route recipient settlement evidence concerns the specific transfer only. Do not claim Razorpay supports an assumed wallet/top-up, settlement webhook field, report API, allocation guarantee, or irrevocability without account-specific authoritative confirmation.

A future provider-neutral settlement interface should expose verified, normalized evidence rather than raw provider payloads; bind provider/account scope, stable event/settlement-line identity, captured payment/order and internal attempt IDs, allocation amount/currency, evidence source/provenance, and provider timestamps; and represent unknown/ambiguous outcomes without mapping them to success or failure. Provider-specific signature, report authentication, corrections, delivery guarantees, and query capabilities must be documented by adapter and tested from approved fixtures. No live provider configuration is implied here.

## 9. Decisions and approvals still required

1. **Product/finance:** exact funding trigger and customer-facing states for captured-but-not-funded; cancellation and support handling while settlement evidence is pending.
2. **Finance/accounting:** recognition point and chart of accounts; gross versus net; provider fees/tax/withholding; split and partial settlement; reserves; refund timing; chargeback, reversal, shortfall and negative-balance treatment; criteria for compensating entries.
3. **Legal/compliance:** merchant of record, funds flow, custody/safeguarding obligations, permitted holding arrangement, jurisdictional disclosures, and authority to operate the proposed escrow model. No legal conclusion is made here.
4. **Provider/operations:** selected merchant/account arrangement and confirmed account-specific settlement API/report/webhook, stable per-payment allocation identifiers, evidence integrity, status/finality semantics, correction/chargeback feeds, access permissions, latency and operational reconciliation procedure.
5. **Security/engineering:** additive schema/evidence contract, retention and restricted access, purpose-bound TOTP authorization for sensitive manual resolution, lock ordering, retry/lease policy, and compatibility handling for existing records.
6. **Release operations:** independent seller recipient verification, Route account approval, human authorization, final transfer evidence and escalation policy. Route settlement does not resolve merchant payment settlement.

## 10. Recommended implementation sequence

1. Obtain the decisions above and authoritative provider/account evidence contracts; do not alter capture/funding behavior before a replacement funding path and customer-state semantics are approved.
2. Approve an additive settlement/allocation data model, uniqueness, evidence provenance, state vocabulary, accounting recognition rules, and historical read compatibility. Review migration SQL before any application.
3. Implement and test a provider-neutral verified settlement inbox/adapter with duplicate-conflict quarantine and read-only reconciliation visibility; no financial posting yet.
4. Change capture processing to record capture only, while preserving cancellation blocking and existing audit/event history. Verify captured-but-not-funded behavior and backward-compatible reads.
5. Implement separately authorized funding from approved settlement evidence with transaction-first locking, exact allocation matching, idempotency, balanced immutable journal, audit/history, and rollback/concurrency tests.
6. Gate release on the approved funding/settlement prerequisite while retaining existing ownership, TOTP, Route approval, transfer verification, and independent finalization controls.
7. Implement approved reversal/refund/chargeback compensation and reconciliation exceptions; test partial, delayed, duplicate, conflicting, concurrent, and rollback cases against isolated PostgreSQL and provider mocks.
8. Enable only after finance/legal/provider operational approval and staging verification. No production readiness or live money movement is authorized by this design.

**Conclusion:** The current system atomically records capture-triggered internal escrow funding, but lacks independent general settlement evidence. Safe separation requires a policy-approved settlement evidence path and accounting model before capture can stop triggering the existing funding bundle. Keep TB-BE-052C orchestration and production release readiness gated on this lifecycle conflict and the approvals above.
