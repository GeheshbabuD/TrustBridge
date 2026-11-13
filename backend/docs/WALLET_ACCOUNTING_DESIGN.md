# Wallet Accounting Design — WB-01 / WB-02A

**WB-02A: COMPLETE (architecture/documentation only). WB-02 implementation: BLOCKED on provider and compliance decisions.** No application, schema, migration, database, or provider changes were made.

## Approved policy and scope

- Existing transaction escrow proceeds continue to be paid directly to sellers by the existing Razorpay Route flow. Escrow release never credits a wallet.
- Wallet funding is a separately initiated and funded flow. It must have its own provider reference, settlement evidence, idempotency identity and journal. A payment or provider reference must never fund both escrow and wallet.
- Wallets are transaction-linked and user-owned, not general-purpose reusable stored-value accounts. Initial currency is INR, integer paise only. A wallet balance is scoped to its actual TrustBridge transaction; funds cannot silently be pooled or moved to another transaction.
- Withdrawals are in product scope, but execution is disabled until provider, destination-verification and compliance requirements are approved.
- Wallet credit becomes pending only after verified independent provider settlement. Capture, authorization, checkout redirect, webhook receipt alone, or provider API acceptance is not settlement. Pending becomes available only after the approved settlement-finality rule passes.
- Escrow and wallet accounts remain separate, as do their journal paths. Reversals use compensating entries; history is immutable. The internal ledger does not establish legal custody.

## Existing implementation

Current `LedgerAccount`, `LedgerJournal` and `LedgerEntry` are transaction/currency scoped. `escrow.service.js` posts `PROVIDER_CLEARING` against `ESCROW_LIABILITY` for verified escrow funding and posts the escrow liability reduction only after verified release/refund results. Existing Razorpay Route release is a direct seller payout. No wallet model, independent funding flow, provider settlement-to-wallet event or withdrawal service exists. There is no assumption that Razorpay Route supports wallet top-ups or wallet custody.

### Source-once and escrow separation invariants

1. A transaction payment/capture follows the escrow path only; it never creates wallet credit.
2. Route release remains a direct seller payout only; it never creates wallet credit.
3. Wallet funding requires a distinct independently initiated provider operation and distinct provider payment/settlement reference.
4. A unique provider/account/reference and settlement-event constraint plus idempotent operation key prevents the same economic source from posting twice or appearing in both domains.
5. Wallet queries include only wallet-owned ledger accounts/buckets. They never sum `ESCROW_LIABILITY`, `PROVIDER_CLEARING`, `Escrow.balanceMinor`, or transaction participation.
6. If funding, settlement, ownership or ledger integrity is missing/ambiguous, fail closed; do not report fabricated zero or available funds.

## Independent funding lifecycle

1. **Intent:** an active, authorized transaction owner initiates a funding intent tied to that exact TrustBridge transaction and wallet account. Server validates INR paise, transaction eligibility and ownership; client cannot supply provider status, settlement reference or ledger account. A durable idempotency record is created before provider dispatch.
2. **Provider payment:** only a selected approved adapter may create the independent provider payment. Persist its provider account scope and unique order/payment reference. This is not the existing escrow PaymentAttempt and cannot be reused by escrow.
3. **Capture:** record verified capture as a non-settlement state. No wallet posting occurs on capture.
4. **Settlement:** an approved provider adapter verifies authoritative final settlement evidence against provider/account, funding operation, reference, INR amount, currency and event identity. In one DB transaction, lock the transaction/wallet/operation in documented order, deduplicate event/reference, store safe evidence references, and post a balanced journal: Dr approved provider-clearing/receivable control account; Cr `WALLET_PENDING` liability. Invalid, absent, delayed, duplicated or ambiguous evidence creates no additional posting and remains pending/reconciliation-required.
5. **Availability:** after the chosen finality rule and reconciliation check, atomically reclassify pending to available: Dr `WALLET_PENDING`; Cr `WALLET_AVAILABLE`. This changes classification only, not total wallet liability.
6. **Apply to escrow:** if product policy allows wallet-funded transaction payment, a separate atomic wallet-to-escrow operation debits the transaction's wallet available liability and credits that transaction's escrow liability. It must not also invoke the external-payment funding posting for the same amount. Mixed wallet/provider funding requires separately approved allocation and idempotency rules.
7. **Refund/reversal/chargeback:** append compensating entries linked to original journal and provider evidence. Do not mutate history. If funds were reserved, withdrawn, or applied to escrow, mark reconciliation/review and follow an approved recovery policy; do not silently make available negative or reverse an unrelated transaction.

Provider event delivery order is not trusted. Capture and settlement are distinct. Provider webhook verification, event identity dedupe, API reconciliation, amount/currency/reference matching and audit references are mandatory. No provider capability is assumed.

## Withdrawal lifecycle

1. Owner requests withdrawal against the specific transaction-linked wallet and amount in paise; require fresh TOTP step-up. Destination is a server-held opaque verified provider reference, never arbitrary client account details.
2. A separate approved destination verification boundary confirms owner and eligibility. Store only minimal metadata/provider token; do not store raw bank credentials. Without the boundary, reject.
3. In one transaction, lock wallet/account and operation in stable order, enforce available balance, claim idempotency, create the request and reserve amount: Dr `WALLET_AVAILABLE`; Cr `WALLET_RESERVED`. Concurrent requests cannot overspend.
4. Provider execution is separate from authorization/reservation and remains disabled absent approved payout configuration. Use one durable provider operation/idempotency reference.
5. Only matched authoritative final payout evidence can finalize success: Dr `WALLET_RESERVED`; Cr approved payout-clearing control account. Provider acceptance is not final payout evidence.
6. Only matched authoritative final no-payout evidence releases the reserve exactly once through compensating reclassification: Dr `WALLET_RESERVED`; Cr `WALLET_AVAILABLE`.
7. Timeout/unknown/pending results retain the reserve and require status lookup/reconciliation. Never blindly retry a payout or create a second provider operation.

## Balance and double-entry rules

All amounts are signed PostgreSQL `BIGINT`/Prisma `BigInt`; serialize as decimal integer strings. Currency is fixed to INR (paise). No floating-point calculation or FX. A bucket balance is derived from committed journal entries, not a mutable balance column. For liability accounts, balance is credits minus debits. Every journal has at least two same-currency entries and equal debit/credit totals before commit. Entries are immutable; reversals point to original journals. Example templates:

- Independent verified settlement: Dr provider-clearing/receivable; Cr transaction-linked `WALLET_PENDING`.
- Pending to available: Dr pending; Cr available.
- Wallet funds applied to transaction escrow: Dr available wallet liability; Cr escrow liability, same transaction/currency and exactly once.
- Withdrawal reserve: Dr available; Cr reserved.
- Final verified payout: Dr reserved; Cr payout-clearing.
- Final verified payout failure: Dr reserved; Cr available.

Exact control-account treatment, provider fees, partial settlement and reversal treatment require accounting/provider review. Preserve existing escrow journal/account IDs and semantics.

## Proposed additive schema direction

Use the existing transaction-scoped double-entry ledger; do not create a parallel wallet journal/entry system or synthetic transaction. Proposed additions:

- `WalletAccount`: UUID, direct `userId` FK, actual `transactionId` FK, fixed `currency CHAR(3)` constrained to `INR`, status/version/timestamps; unique owner+transaction+currency. The record's persisted owner is authoritative. Enforce eligible owner/transaction relationship in constraints or transaction-locked creation logic; never infer ownership from request claims.
- Extend `LedgerAccount` with nullable `walletAccountId` and a constrained wallet bucket (`PENDING`, `AVAILABLE`, `RESERVED`) for wallet-scoped accounts. Existing transactionId/currency and composite journal/account/entry integrity remain. Existing escrow rows have no walletAccountId and preserve their accountCode/type/relations. Wallet bucket account codes must be unique per transaction and wallet; do not collide with existing transaction account-code uniqueness. Enforce that an escrow-linked account cannot be a wallet bucket and that wallet, ledger account and transaction all agree on owner scope and INR.
- `WalletFunding`: wallet FK, positive `amountMinor BIGINT`, `INR`, state, unique owner-scoped idempotency key, provider/account scope, unique independent provider reference, settlement event/reference, journal FK, timestamps and reconciliation state. It is distinct from escrow `PaymentAttempt` and cannot reuse its provider reference.
- `WalletWithdrawal`: wallet FK, positive amount, INR, status, unique idempotency key, verified destination reference, reserve/final journal links, provider operation/reference, verified outcome evidence and timestamps.
- Reuse existing `LedgerJournal`/`LedgerEntry` for wallet postings because each wallet is tied to a real transaction. Add restrictive relations and wallet journal operation/reference uniqueness as needed. Add DB constraints/triggers for balance, immutability, valid bucket scope, no escrow/wallet overlap, source uniqueness, available-balance nonnegativity and atomic status/posting. Do not add mutable wallet balances.
- Link settlement/webhook evidence by stable provider/account/event references; persist identifiers and sanitized metadata, not secrets or unrestricted raw payloads.

Migration SQL must be additive and data-preserving: add wallet tables/columns/constraints/indexes only; do not rewrite, delete or reinterpret existing escrow data. Review SQL, schema diff and trigger/FK ordering. Test migration and constraints only on identity-verified isolated `trustbridge_test`; never reset or broadly delete data. No migration has been created or applied in WB-02A.

## API implications (not implemented)

Do not expose incomplete endpoints. After schema/provider/policy gates pass, candidate owner-authenticated endpoints are `POST /api/v1/wallet/funding-intents`, `GET /api/v1/wallet/funding-intents/:id`, `GET /api/v1/wallet`, `GET /api/v1/wallet/transactions`, `POST /api/v1/wallet/withdrawals`, and `GET /api/v1/wallet/withdrawals/:id`. Server derives owner from authenticated context; all mutations require strict validation/idempotency and appropriate TOTP step-up. Funding status never comes from the client. Responses expose safe reference/type/status/amount/currency/timestamps only. Missing wallet/accounting data is not a verified zero. Wallet APIs are not bank balances, custody statements or guarantees of immediate withdrawability.

## Concurrency, audit and reconciliation

Lock order: actual `Transaction` row, `WalletAccount`, funding/withdrawal operation, then ledger accounts/journal. Use the same order for funding settlement, availability, wallet-to-escrow application, withdrawal, reversal and reconciliation. Unique provider references/event IDs/idempotency keys arbitrate duplicate requests across instances. Conditional state updates ensure one posting per operation; journal entries and operation/evidence state commit in one DB transaction. Failed transactions leave no partial journal or operation state. Audit intent, verification, posting, reservation, execution, reversal and reconciliation with safe opaque references only. Mismatches become review cases; never silently correct ledger.

## Tests required before WB-02 completion

Schema/migration contract, owner/transaction/currency scope, account-bucket uniqueness, escrow exclusion, trigger balance/immutability and legacy-row preservation; independent wallet funding (capture vs settlement, invalid/duplicate/out-of-order evidence, exact amount/reference); no credit from escrow funding or Route release; cross-user denial; empty provisioned vs absent wallet; INR/BigInt boundaries; wallet-to-escrow exactly once; pending/available/reserved movements; balanced reversals without history mutation; insufficient/concurrent withdrawals; duplicate idempotency; verified success/failure vs ambiguous payout; rollback; reconciliation; audit safety; HTTP validation/rate limits/TOTP. Use provider mocks only and independent PostgreSQL clients on verified `trustbridge_test`. No live financial operations.

## WB-02 blockers / unresolved external decisions

1. Select an independent wallet-funding provider and verify top-up, authoritative settlement reporting, idempotency and reversal capabilities. Razorpay Route top-up capability is not assumed.
2. Confirm top-ups/transaction-linked wallet balances/withdrawals are legally and contractually permitted; identify custody, safeguarding, compliance and operational obligations.
3. Define authoritative settlement finality, availability timing, fees, partial settlement, refunds, chargebacks and negative-balance/recovery policy.
4. Select an approved payout provider and verified destination-ownership process; define final payout/no-payout evidence and retry guarantees.
5. Decide whether transaction participants and transaction states permit wallet funding/application/withdrawal, including cancellation and unused funds.

**WB-02A is complete as a reconciled design. WB-02 remains blocked until these decisions are approved. Next safe implementation:** provider/custody decision and accounting sign-off, then additive schema and isolated invariant/concurrency tests; only then implement services with mocked providers. Do not claim production readiness.

## WB-02B — provider and accounting readiness (2026-11-12)

### Verified from repository implementation

`razorpay-payment.adapter.js` creates standard `/v1/orders`, verifies checkout payment signatures, verifies raw-body webhook signatures, normalizes order/payment events (`order.paid`, `payment.captured`, `payment.authorized`, `payment.failed`), fetches payment details and order payment status, and supports refund create/fetch with an idempotency header. The normalized capture outcome remains non-final (`final: false`); payment service persists capture evidence but does not persist independent wallet settlement evidence.

The adapter's Route methods create linked accounts and transfers, fetch transfer status, and support holds/reversals behind explicit approval callbacks. `razorpay-escrow.executor.js` finalizes an escrow release only after matching transfer/payment/account/amount/currency and `transfer_status=processed` plus `settlement_status=settled`. That evidence is specific to a Route transfer to a linked account; it is the existing direct seller payout and must never credit a wallet. Route account resolution/approval remains separately gated.

Not present: wallet funding intent/provider adapter, settlement webhook normalization or durable wallet settlement evidence, settlement-to-wallet reconciliation, generic payout adapter/destination verification, KYC/destination ownership integration, wallet refund/chargeback accounting. Existing payment refunds are tied to the original captured payment and return provider refund status; they do not implement wallet credit reversals. No settlement finality rule is configured for independent wallet funding.

### Official provider documentation checked

Razorpay's Orders API creates a payment order and reports amount/currency/order state; the order's `paid` state follows successful capture. The payment integration guide distinguishes capture from settlement to the merchant account on its settlement schedule. Razorpay's FAQ explicitly says Razorpay is not a wallet provider. Route documentation describes linked-account transfers, including a transfer's own `settlement_status` and a Route settlement lookup; those interfaces establish Route transfer/linked-account settlement evidence, not a wallet top-up product or generic user wallet payout. Razorpay refund docs/API provide refund operations and status; a refund request/status must be reconciled to the original payment, not treated as a wallet credit.

References: [Razorpay Orders API](https://razorpay.com/docs/api/orders/create/), [Razorpay payment integration and capture/settlement guidance](https://razorpay.com/docs/server-integration/python/test-app/), [Razorpay FAQ — wallet-provider scope](https://axisbank-docs.razorpay.com/payments/FAQs/), [Route: fetch transfers for a settlement](https://razorpay.com/docs/api/payments/route/fetch-transfers-for-a-settlement/), [Route overview](https://razorpay.com/route/), and [Razorpay refunds FAQ](https://razorpay.com/docs/pos/refunds/faqs/). Documentation capability does not establish eligibility, account enablement, legal authority, or a contracted service for TrustBridge.

### Required adapter contracts

1. **Wallet funding adapter (not implemented):** create independent funding intent/order keyed to a persisted wallet-funding operation; fetch payment and settlement independently; verify raw webhook signature/event identity; normalize capture separately from settlement; return authoritative settlement ID, exact gross/net amounts, fees, INR, provider account scope, source payment/order reference, settlement timestamp/status, reversal/chargeback evidence; support idempotent reconciliation. No wallet journal posting until evidence matches the durable intent and adapter says settlement is final per approved policy.
2. **Wallet refund/reversal evidence (not implemented):** create/query refund only for the independent wallet-funding payment; correlate refund ID/payment ID/amount/currency; consume verified refund/chargeback events and create compensating entries; preserve pending/ambiguous status. Refund capability must not be inferred from the existing transaction escrow refund executor.
3. **Withdrawal destination verifier and payout adapter (not implemented):** verify recipient ownership/eligibility and return a stable opaque destination reference; create payout with durable operation idempotency; fetch final status; verify payout ID, destination, amount, INR, terminal bank/provider outcome and reversal/return events. A Route transfer executor is not a generic bank payout contract and must not be repurposed without approved product/provider evidence.

### Evidence and business/compliance gates

- **Settlement:** require authenticated webhook or authoritative API/report result, provider event ID, settlement ID, provider account scope, source payment/order ID, matching intent, INR amount/fee breakdown and terminal settled state. Capture, order-paid, webhook receipt, a settlement schedule, or a Route transfer settled flag for an unrelated linked-account transfer is insufficient. If provider APIs cannot prove source-level settlement and exact net amount, remain BLOCKED.
- **Reversal:** require a verified provider refund/chargeback/reversal event or authoritative fetch matching the original settlement/payment and amounts. Record the event/reference and post compensating entries once. Define partial refunds, fees, chargeback timing, already-withdrawn funds and negative-balance handling before implementation.
- **Payout:** require verified destination ownership before request and provider-authoritative final success or definitive no-payout before final debit/reservation release. Provider acceptance, queued/processing, timeout or missing webhook remains ambiguous and retains reserve.
- **Business/legal:** select an independent funding provider and confirm it supports this INR use case; confirm top-ups and transaction-linked balance/withdrawal are permitted under provider contract and applicable legal/compliance rules; identify custody/safeguarding obligations; approve KYC/AML, disputes, limits, fees, dormant funds, records and operational ownership. These require business/legal/provider approval; this code review cannot establish them.

### WB-02 readiness decision

**BLOCKED — do not start wallet schema/service implementation yet.** The current provider adapter supports standard payment capture, refunds and Route-linked-account transfers, but not the separate wallet funding and source-level settlement evidence required by policy. Official docs do not establish Razorpay as a wallet/top-up provider; Route settlement applies to Route transfers, not an independently funded wallet. No provider has been selected/contracted for independent wallet funding or withdrawal, and custody/compliance/finality decisions remain open. Starting tables that encode an unselected settlement/finality contract risks incorrect financial states. The existing transaction-scoped ledger is structurally reusable for a transaction-linked INR wallet, but schema must follow the selected evidence contract; it must preserve escrow account/journal scope and never credit wallet from Route/escrow.

**Next safe task:** provider capability and legal/compliance decision record. After that, design the exact adapter evidence contract and schema constraints; then implement against mocked adapters, with production execution disabled until provider staging and isolated PostgreSQL verification pass.
