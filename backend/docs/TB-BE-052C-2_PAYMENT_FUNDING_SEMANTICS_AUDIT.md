# TB-BE-052C-2 — Payment Capture and Escrow Funding Semantics Audit

**Status:** Read-only source/test audit. No code, schema, migration, database, or provider changes.

## Confirmed behavior

### Capture entry points

The payment service verifies provider evidence before persisting capture:

- Checkout verification validates the signature, fetches provider payment details, and matches payment ID, order ID, amount, and currency (src/services/payment.service.js, approximately lines 195–219).
- Payment status reconciliation requires a verified provider result, matching provider/order reference, amount, currency, and final/no-capture evidence for failure outcomes (approximately lines 224–277).
- Webhook processing verifies and normalizes the signed event before entering the transaction; it locks the transaction, matches the attempt/reference/amount/currency, and handles duplicates and contradictory terminal events (approximately lines 295–350).

In all three paths, a captured result is persisted as PaymentAttempt.status = CAPTURED (and capturedPaymentId for Razorpay) and then fundingService.recordVerifiedFunding(...) is called when the service is configured. The normal payment route always supplies an escrow service (src/routes/payment.routes.js, service construction near lines 17–24). The funding call also occurs for duplicate already-captured outcomes to recover idempotently.

### What recordVerifiedFunding records

src/services/escrow.service.js, recordVerifiedFunding (approximately lines 39–77), does both of the following in one caller-owned transaction:

1. Requires a CAPTURED attempt and matching positive amount/currency to the transaction. It does not itself call the provider or validate a settlement allocation; it trusts the verified caller and the persisted capture state.
2. Creates internal escrow funding accounting and changes transaction/escrow state.

For a first funding operation it:

- Upserts an Escrow row as UNFUNDED, initially zero balance.
- Upserts PROVIDER_CLEARING (ASSET) and ESCROW_LIABILITY (LIABILITY) ledger accounts.
- Creates one uniquely keyed LedgerJournal with operation ID FUNDING:<paymentAttemptId>.
- Creates two equal integer-minor LedgerEntry rows: debit PROVIDER_CLEARING, credit ESCROW_LIABILITY.
- Creates a successful EscrowOperation of type FUNDING, linked to the payment attempt and journal, with reasonCode = VERIFIED_PROVIDER_CAPTURE.
- Conditionally advances the transaction from AWAITING_PAYMENT to FUNDED and increments its version.
- Updates escrow to FUNDED, sets its balance and fundedAt.
- Creates transaction status history, an ESCROW_FUNDED audit entry, and participant-notification outbox events. If blockchain integration is enabled, it also creates a status-commitment record and outbox event.

These writes occur inside the payment caller's transaction while the transaction row is locked. A failure rolls back the capture update and funding bundle together. The unique operation key prevents duplicate funding journals; the balanced journal and existing ledger constraints remain active. The escrow model comment says this is an internal accounting/workflow record and does not itself represent legal custody.

## Exact policy conflict

The approved policy says payment capture and escrow funding are distinct and capture alone must never establish escrow funding. The current application instead uses verified capture as the direct trigger for:

- a successful FUNDING escrow operation whose reason explicitly says VERIFIED_PROVIDER_CAPTURE;
- a provider-clearing-to-escrow-liability journal;
- Escrow.status = FUNDED and a positive escrow balance; and
- Transaction.status = FUNDED.

Therefore, the implementation does not merely store two independent events. It treats capture evidence as sufficient to create the internal escrow funding posting and state transition. It does not establish provider settlement or custody; no settlement allocation/reference is validated or persisted by this path. The PROVIDER_CLEARING account is the internal accounting representation used, not settlement proof.

The related unit test explicitly asserts that “verified capture” creates the balanced journal and advances escrow/transaction state (tests/unit/escrow-ledger.test.js, test near line 28). PostgreSQL tests exercise concurrent verified capture/funding and assert one journal, one funding operation, funded escrow and transaction state (tests/postgres/escrow-ledger.integration.test.js, around lines 69–85; tests/postgres/payment-concurrency.integration.test.js, around lines 145–166). Those tests verify the current behavior and its atomicity/idempotency; they do not verify capture-versus-settlement separation. No tests were run for this read-only audit.

Cancellation is separately guarded: src/services/transaction.service.js rejects cancellation from AWAITING_PAYMENT unless every attempt has a processed provider-verified terminal no-capture result, and capture remains unresolved. Release authorization later requires a funded escrow plus delivery/dispute and TOTP controls. A correction must preserve these safeguards and must not make a captured attempt cancellable or release-eligible.

## Reconciliation distinction without transaction-state inference

Eligibility should include transactions with payment attempts or escrow/ledger/operation artifacts regardless of Transaction.status. In the same REPEATABLE READ, SET TRANSACTION READ ONLY snapshot, reconciliation can compare:

- captured PaymentAttempt rows;
- matching EscrowOperation rows by paymentAttemptId, requiring type FUNDING and status SUCCEEDED;
- the operation's linked journal and entries, checked by the existing evaluator for transaction/currency scope, balanced lines, amount and escrow-liability effect; and
- the escrow record and liability balance.

A capture-without-internal-funding-posting category can be identified when a persisted captured attempt has no matching successful funding operation and valid linked journal/escrow projection, regardless of transaction status. Capture or a FUNDED transaction label alone is insufficient. Conversely, a matching operation/journal proves only the current internal posting, not provider settlement. A separate settlement-confirmed classification cannot currently be produced because settlement evidence is not modeled or read by the payment/escrow reconciler.

The existing createLedgerReconciliationService does not select PaymentAttempt; it must be extended to read the minimum attempt fields in the same read-only snapshot before it can emit this category. Do not fetch payment attempts in a separate query/transaction and combine them with the ledger report, as that can observe a different state. Do not persist payment references or amounts in discrepancy findings.

## Smallest safe correction

The smallest semantic correction is to stop calling recordVerifiedFunding from capture-only callback, status-reconciliation, and webhook branches. Capture processing should persist only provider-verified PaymentAttempt outcome and its capture-event/audit metadata. A separate funding operation must be triggered only by an independently verified funding/settlement evidence event and must retain transaction locking, idempotency, amount/currency/reference matching, balanced immutable journal posting, audit, and guarded state transition.

However, the repository currently has no general payment-settlement evidence adapter/model or approved settlement-finality contract. Removing the calls immediately would leave new captured transactions at AWAITING_PAYMENT with no path to become internally funded; leaving the calls in place contradicts policy. Thus this is not a safe isolated refactor inside the reconciliation task. Before implementation, product/finance/legal/compliance must approve the funding trigger and treatment of captured-but-unsettled funds, and provider/operations must confirm available account-specific settlement evidence. Then a separate payment/escrow change can add the evidence path and adjust lifecycle/API behavior. Until then, do not claim settlement-confirmed escrow funding or production release readiness.

## Historical implications

Do not rewrite, delete, reverse, or silently relabel existing EscrowOperation, journal, entries, escrow balances, transaction statuses, or status-history rows. Existing funding operations already retain reasonCode = VERIFIED_PROVIDER_CAPTURE; related status history uses VERIFIED_PAYMENT_FUNDING. Preserve those facts as the record of the legacy capture-triggered accounting behavior, not as proof of provider settlement.

Any transition must define how existing FUNDED transactions, pending release/refund operations, and already-created ledger entries are handled. If later review finds a mismatch, use a separately approved, auditable compensating process; do not bulk-change historical postings or infer settlement retrospectively. Backward-compatible reads must distinguish legacy capture-triggered postings from future settlement-evidenced funding without changing old rows.

## Approval and follow-up requirements

- Product and finance: identify the event that makes funds eligible for internal escrow funding and define the customer-visible/payment-versus-escrow state while capture is not yet funded.
- Finance/accounting: approve gross/net, provider-clearing/receivable and escrow-liability timing, including fees, partial settlement, reversals, and chargebacks.
- Legal/compliance: confirm the funds-flow and custody obligations; this audit makes no legal conclusion.
- Provider/operations: verify account-specific settlement API/report/webhook evidence and stable payment-to-settlement allocation references. Capture and Route transfer settlement are not substitutes.
- Security/engineering: approve an additive evidence contract, event idempotency and access/retention; preserve transaction-row serialization and ensure cancellation still rejects captured attempts.
- Testing: update current tests that intentionally assert capture-triggered funding; add tests proving capture alone creates no escrow/ledger posting or FUNDED state, distinct verified funding creates exactly one balanced journal, cancellation remains blocked after capture, and historical rows are preserved unchanged. Use mocked provider evidence and isolated PostgreSQL concurrency/rollback tests only.

**Recommendation:** The conflict is confirmed. Keep the current records unchanged while the funding-evidence policy and provider capability are approved. Do not implement a partial decoupling that strands captured transactions or equates a capture with settlement.
