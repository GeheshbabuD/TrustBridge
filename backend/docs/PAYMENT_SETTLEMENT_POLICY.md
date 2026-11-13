# Razorpay Settlement Evidence and Accounting Policy

**Status:** Assessment only — no application, schema or database changes. Settlement policy and production use remain blocked pending product, accounting, legal/compliance and provider approval.

## Current payment-to-escrow flow

1. Payment initiation locks the transaction, checks the buyer, accepted terms and amount/currency, creates a `PaymentAttempt` plus outbox record, then creates or resolves a Razorpay Order using the stable attempt receipt.
2. Checkout verification requires the callback HMAC and a server-side payment fetch. Webhook handling verifies the original raw request bytes before normalization. Reconciliation fetches payment status for the persisted order. These paths compare the payment/order reference, amount and currency and do not accept a client-supplied success state.
3. When a verified provider payment is `captured`, `payment.service.js` stores `PaymentAttempt.CAPTURED` and calls `escrow.service.js:recordVerifiedFunding` in the same transaction. That service writes an `EscrowOperation(FUNDING)`, balanced `PROVIDER_CLEARING` debit / `ESCROW_LIABILITY` credit, changes `Escrow` and `Transaction` to `FUNDED`, and writes history/audit. The funding operation is separately persisted and idempotent, but its current evidence is the capture outcome (`VERIFIED_PROVIDER_CAPTURE`), not a settlement record.
4. Release/refund authorization and provider execution are separate escrow operations. Route release resolves the seller account server-side, links the operation to `PaymentAttempt.capturedPaymentId`, fetches the transfer and finalizes only when the transfer matches the payment, account, amount and currency and has `processed` plus `settled` evidence. This is evidence about that Route transfer/recipient settlement, not proof that a general payment was settled to TrustBridge.

## Capture is not settlement

`PaymentAttempt.CAPTURED` means the provider reports a captured payment. It does not, by itself, prove that the merchant settlement batch completed, what net amount was credited, whether fees/withholdings/adjustments applied, where funds were credited, or whether TrustBridge has legal or operational control of those funds. A signed capture event is valid capture evidence; it is not a settlement receipt.

Consequently, the present capture-to-`FUNDED` behavior is an internal accounting convention that lacks a separate settlement evidence gate. `PROVIDER_CLEARING` is an internal ledger account, not a bank confirmation or custody representation. The code must not describe capture as settled or held funds. Until the policy below is approved and the appropriate evidence integration is implemented, do not infer settlement finality or production escrow custody from the current status.

## Razorpay capabilities: verified versus unverified

| Capability | Assessment |
|---|---|
| Create order; fetch payment; payment capture state; raw-body-signed webhooks | Implemented in the adapter/core for order creation, callback signature+payment fetch, `payment.authorized`/`payment.captured`/`payment.failed` normalization, and payment status lookup. Current reconciliation matches the persisted order and exact amount/currency. |
| Settlement notifications generally | Razorpay's webhook overview says webhook events cover settlements as well as payments. The exact standard-payment settlement event names, payload fields, account/product eligibility, delivery guarantees and availability for this TrustBridge account are **UNVERIFIED**. The current adapter does not normalize settlement events. |
| Standard payment-to-merchant settlement reports/APIs | Razorpay describes settlement details in the Dashboard and settlement reports that map payments to settlement identifiers. The project does not call or ingest a standard-payment settlement API/report, and the exact machine-readable API, access permissions, report completeness, lateness and correction semantics are **UNVERIFIED** for the intended merchant arrangement. |
| Route recipient transfer settlement | Official Route API documents listing transfers by `recipient_settlement_id`, and transfer data with source payment/order, transfer amount/currency/status, `recipient_settlement_id`, settlement status and optionally expanded settlement details. This is scoped to Route transfers/linked accounts. It cannot be treated as general gateway settlement evidence or proof of TrustBridge custody. |
| Settlement finality / irrevocability | **UNVERIFIED.** A `processed` status and settlement ID establish a provider-reported event according to the relevant endpoint, not legal irrevocability, protection from later reversals, chargebacks or recovery. Product/legal/accounting must define the operational finality threshold. |
| Refunds, reversals and partial adjustments | Existing refund executor validates a refund against the captured payment and amount and queries refund status. It is not a settlement-allocation reconciler. Route reversals are a distinct transfer operation. Treatment of a refund before/after settlement, fees, chargebacks, partial settlement, settlement reversal and recovery rights requires provider/product/accounting confirmation. |

Official references: [Razorpay About Webhooks](https://razorpay.com/docs/webhooks/); [Razorpay payment dashboard actions and settlement details](https://razorpay.com/docs/payments/payments/dashboard/); [Route Fetch Transfers for a Settlement](https://razorpay.com/docs/api/payments/route/fetch-transfers-for-a-settlement); [Route Fetch Settlement Details](https://razorpay.com/docs/api/payments/route/fetch-settlement-details). These references do not establish the account's product access, settlement contract or legal treatment.

## Proposed state model and evidence gates

Keep the existing payment-attempt state machine separate from settlement and escrow. A future settlement record should distinguish at least:

- `UNOBSERVED`: no settlement evidence received.
- `PENDING`: provider reports a settlement initiated/created, or matching evidence is incomplete.
- `PARTIALLY_SETTLED`: verified allocated amount is below the policy-required amount; no release eligibility.
- `SETTLED`: verified settlement item(s) reconcile to the applicable captured payment amount and settlement policy; only this state may satisfy the approved settlement prerequisite.
- `FAILED`: provider-authoritative terminal failure for the identified settlement; preserve captured-payment state and exception history.
- `REVERSED` / `ADJUSTED`: provider-authoritative correction, return, chargeback or recovery after prior processing; create compensating accounting entries and re-evaluate release eligibility.
- `RECONCILIATION_REQUIRED`: contradictory, unmatched, duplicate-with-different-content, stale or incomplete evidence; block financial finalization pending human review.

The settlement evidence record must bind provider/account scope, settlement ID, payment ID or documented allocation reference, PaymentAttempt ID, order ID, currency, gross/net/fee/tax/adjustment amounts, provider event/report provenance, provider effective/received times and an integrity/idempotency key. Batch settlement can include many payment allocations; never assign an aggregate batch amount to each payment. Do not mark a payment fully settled based on a partial allocation. If a report lacks a stable payment-level mapping, keep it unmatched and require reconciliation rather than guessing by amount or time.

Evidence is sufficient only after signature verification for webhook evidence or authenticated retrieval/validated ingestion for report/API evidence, exact provider account and currency match, stable settlement and payment identifiers, exact amount/allocation reconciliation, duplicate detection, and corroboration against persisted captured payment/order. A webhook receipt is not necessarily finality; retrieve authoritative status/report details where available. Missing or delayed evidence stays pending. No timeout or elapsed period implies settlement or failure.

## Reconciliation and exception handling

1. Persist verified settlement events/reports in a durable provider-scoped inbox before acknowledging. Retain only normalized allowlisted evidence, integrity references and provenance; do not log raw payloads or financial credentials.
2. Deduplicate by provider account plus provider event/settlement-item identity, and separately enforce a unique business allocation per captured payment/settlement line. Conflicting content for the same identity is quarantined, never overwritten.
3. Lock in consistent order: Transaction, PaymentAttempt, settlement/allocation record, Escrow/operation, ledger journal. Validate capture reference, settlement reference, amount, currency and allocation totals under the lock; use conditional state/version updates and one database transaction for evidence state, accounting, history and audit.
4. Pending or delayed items remain pending; partial values remain partial. Failed/reversed/chargeback items create a reconciliation case and compensating entries only when authoritative evidence and approved policy permit. Never edit posted ledger history or retry a payout because status is ambiguous.
5. Human finance review resolves unmatched, fee/amount variance, partial, reversal or contradictory items under least privilege and required TOTP step-up. Review decisions are audited, versioned and idempotent. AI or blockchain data cannot resolve these cases or authorize movement.
6. Daily/provider-report reconciliation compares captured payments, settlement allocations, escrow postings, refunds/reversals and Route payout records. Differences remain visible as exceptions; do not silently “balance” them with a journal.

## Accounting implications and safeguards

The intended model separates (a) customer payment capture, (b) provider receivable/settlement evidence, (c) internal escrow liability/funding eligibility, and (d) seller Route release/refund. Accounting must decide whether captured-but-unsettled funds are represented as an unsettled receivable plus a pending customer/escrow obligation, or whether funding eligibility is withheld until a settlement allocation is confirmed. The exact chart of accounts and timing must be approved by the finance/accounting owner; this document does not assert trust custody or safeguarding.

When approved, use immutable balanced BigInt minor-unit journals and compensating entries. Keep capture/order IDs, settlement batch/line IDs, refund IDs and Route transfer/recipient settlement IDs in their own typed references. Enforce uniqueness and transaction-row locking to prevent one captured source from funding both escrow and another financial source. Fees, taxes and net settlement must reconcile separately from the gross customer obligation. No escrow release is eligible from `CAPTURED`, `PENDING`, `PARTIALLY_SETTLED` or `RECONCILIATION_REQUIRED` alone. Route seller release requires its own independent human authorization and verified final transfer evidence. Refund/reversal execution remains in TB-BE-039 with its own authorization and provider result; a refund API acceptance is not a completed ledger reversal.

No historical ledger entry should be rewritten. Any approved transition from the current capture-based posting must define treatment of existing `FUNDED` transactions, open escrow operations, pending releases/refunds and reconciliation evidence using additive, auditable corrections only.

## Decisions requiring approval

- Product and finance: whether capture or payment-level settlement is the point at which a transaction is considered fundable, and whether escrow is internal accounting only or represents any custody obligation.
- Legal/compliance: merchant-of-record, funds flow, custody/safeguarding, applicable payment-aggregator/marketplace obligations, chargeback exposure and required disclosures. No compliance conclusion is made here.
- Provider/operations: exact Razorpay product/account arrangement, settlement event/report/API access, stable payment-level allocation fields, status semantics, webhook subscription, retries, reconciliation cutoff and available retention/export.
- Finance: gross-versus-net journal design, fee/tax treatment, split/partial settlement, holds, failed/reversed settlements, chargebacks and negative/shortfall funding policy.
- Product/operations: release eligibility threshold and human exception authority; Route settlement evidence must remain scoped to the specific recipient transfer.
- Security: provider-account scope, secret rotation, evidence retention and access controls for reports and settlement payloads.

## Recommended implementation phases

1. Obtain written product/legal/finance decisions and confirm the exact Razorpay merchant and Route account capabilities without enabling live money movement.
2. Obtain official account-specific API/report/webhook contracts and fixtures; prove how one payment ID maps to one or more settlement allocations and how corrections appear.
3. Approve an additive settlement model and migration (settlement batch/item, payment allocation, state/provenance/unique constraints) plus a backward-compatible handling plan for existing funded rows. No migration is proposed in this assessment.
4. Implement a provider-neutral settlement evidence adapter, signature/report validation, idempotent inbox, transaction-first locking and reconciliation exceptions. Keep production execution disabled.
5. Implement approved pending/settled accounting with balanced immutable journals and explicit reversal/partial/fee handling; ensure release gates use settled evidence plus existing ownership/TOTP checks.
6. Add mocked unit/HTTP tests and isolated PostgreSQL tests for duplicate, delayed, partial, mismatched, reversed, concurrent and rollback cases; verify with approved Razorpay staging before any production enablement.

## TB-BE-049 source audit confirmation (2026-11-12)

The current implementation matches the capture-based flow described above: `payment.service.js` calls `recordVerifiedFunding` for verified CAPTURED outcomes during callback, reconciliation and webhook processing; funding posts `PROVIDER_CLEARING` against `ESCROW_LIABILITY` and sets transaction/escrow FUNDED. Release eligibility then depends on funded escrow and delivery/dispute authorization. Route transfer `processed` plus recipient `settled` evidence is checked at execution, but does not establish general merchant settlement. This is a HIGH policy gap for production release readiness, not evidence of an unbalanced or duplicate posting in the ordinary service path. General settlement allocation, chargeback and reversal ingestion remains absent. See `FINANCIAL_LIFECYCLE_AUDIT.md` for the full findings, test evidence and sequence. No code/schema/database changes or tests were made in this audit.
