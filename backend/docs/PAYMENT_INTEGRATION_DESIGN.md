# TB-BE-038 — Payment Integration Architecture and Compatibility Audit

**Phase:** 1 design and Phase 2 provider-neutral core implemented and verified; TB-BE-038 is **COMPLETED**. No production provider is selected or enabled.
**Date:** 2026-11-04
**Scope:** provider-neutral payment initiation, payment-attempt verification and durable webhooks. No payment, escrow, ledger, refund, payout or dispute implementation is authorized by this report.

## 1. Existing implementation assessment

| Area | Verified current state | Compatibility implication |
|---|---|---|
| `Transaction` / `PaymentAttempt` | `PaymentAttempt` has transaction ID, provider, one optional `providerReference`, per-transaction idempotency key, `PaymentAttemptStatus`, `BigInt` minor amount, `CHAR(3)` currency, failure code and timestamps. It has a restrictive composite relation to `(Transaction.id, Transaction.currency)`, unique `(transactionId,idempotencyKey)` and `(provider,providerReference)`, and transaction/status indexes. | The amount/currency FK is a strong invariant. Provider account scope, distinct provider order/capture references and verified outcome provenance are not represented. There is no payment-attempt history model. |
| Transaction APIs/services | `transaction.service.js` owns creation/idempotency, buyer/seller participants, terms/invitations, status transitions and atomic transaction history/audit. Terms must be mutually accepted before payment can be requested. | Payment initiation must use persisted buyer participation and agreed transaction snapshot, never client-supplied amount/currency or participant identity. |
| Cancellation guard | TB-BE-050 locks the transaction row and permits `AWAITING_PAYMENT→CANCELLED` only if no `PaymentAttempt` row exists. Any attempt, including locally labelled `FAILED` or `CANCELLED`, returns `PAYMENT_OUTCOME_UNVERIFIED`. Storage failure fails closed. | Safe but restrictive. A future relaxation requires durable, verified terminal no-capture evidence, not a status label alone. |
| Durable workflow | `WebhookEvent` is unique by provider/account scope/event ID, has a minimal JSON event envelope, processing status, attempt/retry and lease fields, safe error code, optional attempt relation and query indexes. `IdempotencyOperation` stores a keyed fingerprint and scoped unique key. `OutboxEvent` supports unique event keys, leases and retries. | The inbox/outbox/idempotency foundations can be reused. There is no webhook ingestion/worker, provider event verifier or payment idempotency use yet. `ProviderOperationStatus` is an enum only; no ProviderOperation model exists. |
| Audit and history | Transaction status changes append `TransactionStatusHistory` and redacted `AuditLog` in the same transaction. Audit immutability is by service policy. | Payment-attempt status transitions currently have neither dedicated history nor audit producers. Add an append-only-by-policy attempt history or an equivalent durable record before processing provider outcomes. |
| Authentication/authorization | Transaction routes require authentication and persisted participant authorization; `requirePaymentAttemptParticipant` exists for future reads. ADMIN has no ownership bypass. | Initiation is buyer-participant-only. Webhook workers use a server/provider-verification identity and must not masquerade as a buyer or ADMIN. |
| Rate limiting and body handling | `/api/v1` has a shared rate limiter; production requires shared Redis. No payment-specific route exists. `src/app.js` runs `express.json()` before route registration and does not preserve raw bytes. | Webhook signature verification needs route-specific raw-body capture before JSON parsing (or a narrowly scoped parser `verify` hook). Add endpoint-specific shared limits without weakening the global limit. |
| Configuration/readiness | `PAYMENT_ENABLED` defaults false in `.env.example`; when enabled, Zod requires provider ID, API key, API secret and webhook secret. Secrets are non-enumerable in runtime config. No provider is selected by this task. Readiness reports DB as `not_checked` and does not report payment-provider availability. | Keep payments disabled until provider eligibility, configuration and adapter are verified. Add provider health only when an adapter exists; readiness must not expose credentials or imply legal custody. No `.env` contents were inspected. |

No payment HTTP route, payment adapter, signature verification, provider-event normalization, reconciliation worker or payment-attempt status service was found. Existing automated tests create model fixtures and test cancellation guards; they do not exercise a real provider or payment API.

## 2. Recommended provider-neutral architecture

Use a narrow `PaymentProviderAdapter` behind a service boundary. Provider-specific SDKs, request signing, response mapping and webhook formats must remain inside the adapter. The domain service should depend only on normalized values.

Proposed adapter capabilities (provider selection may show that some are unsupported):

- `createPaymentIntent({ providerAccountScope, providerIdempotencyKey, attemptReference, amountMinor, currency, returnContext })` returns a normalized result: provider reference, provider state, and only allowlisted client continuation data if the provider requires it.
- `verifyWebhook({ rawBody, headers, secretResolver, receivedAt })` returns verified identity/provenance or a generic invalid result. It must not mutate application records.
- `normalizeWebhook(verifiedEnvelope)` returns provider account scope, event ID/type, provider occurrence time/sequence if supplied, provider reference, normalized outcome and amount/currency where available.
- `fetchPaymentStatus({ providerAccountScope, providerReference })` returns a normalized status or `UNKNOWN`; it must not fabricate a final result when the provider is unavailable or ambiguous.
- Optional capability metadata must state whether the provider supports idempotent order creation, signed/timestamped events, status queries, terminal no-capture evidence and event ordering. Do not assume any capability before provider review.

Services own authorization, idempotency, persistence and state transitions. Controllers validate and serialize; they never call provider SDKs. Provider network calls happen outside database transactions. Store only provider references, normalized status and necessary safe metadata—never PAN, CVV, bank credentials, authentication challenges, webhook signatures or raw provider bodies.

Recommended initiation is asynchronous and outbox-driven: atomically reserve the attempt, update the transaction to `AWAITING_PAYMENT`, claim the caller's idempotency key and write a `PAYMENT_INTENT_CREATE` outbox event; then a worker calls the adapter with a stable provider idempotency key. Return `202 Accepted` with an attempt ID/status, not a claim of payment. If product requires synchronous checkout creation, persist the attempt first under the same transaction lock, make the external call after commit, and treat timeout as ambiguous; do not hold a SQL transaction open over network I/O.

## 3. Provider adapter contract and normalized evidence

The adapter maps provider-specific outcomes to a small internal vocabulary. It must identify whether a result came from an authenticated provider API response, a verified signed event, or a reconciliation query, and preserve event/reference provenance. A redirect URL, browser callback, front-end success message, client transaction ID or unsigned event is never evidence.

Normalize an event before it reaches the domain service. Reject or quarantine missing/invalid event identity, provider-account mismatch, unknown attempt reference, amount/currency mismatch, or an unsupported event type. Do not log provider request/response bodies, signatures or credential-bearing continuation data. Provider errors must be translated to bounded internal error codes; detailed upstream messages stay out of API responses and logs.

## 4. PaymentAttempt state model

`PaymentAttemptStatus` currently contains `CREATED`, `PENDING`, `CAPTURED`, `FAILED`, `CANCELLED`.

| Transition | Authority and meaning | Terminal? | Retry/reconciliation rule |
|---|---|---:|---|
| no attempt → `CREATED` | Local transaction reserves the buyer-authorized attempt and durable provider-create work. Amount/currency come from the accepted transaction terms. | No | Unique operation key returns the same attempt on identical retry; key reuse with a different fingerprint conflicts. |
| `CREATED` → `PENDING` | Adapter reports the provider intent/order accepted, or the call outcome is indeterminate after dispatch. | No | On ambiguity, keep funds blocked and query/reconcile using the same provider idempotency key; do not create a second charge. |
| `CREATED`/`PENDING` → `CAPTURED` | Authenticated provider API response or verified event/status query proves capture, and attempt reference, amount and currency match. | Yes for this charge attempt | Duplicate same outcome is a no-op. Conflicting or late events create a reconciliation case; never regress the attempt. |
| `CREATED`/`PENDING` → `FAILED` | Authoritative provider evidence establishes final failure and no capture. A timeout, transport error or missing event is not final failure. | Yes | Retry only under adapter idempotency guarantees; otherwise query status first. |
| `CREATED`/`PENDING` → `CANCELLED` | Provider-confirmed cancellation/void with no capture, or a locally proven not-dispatched operation. | Yes | Provider capability and evidence type must be documented. Unknown state remains unresolved. |
| `CAPTURED`, `FAILED`, `CANCELLED` → another payment status | No ordinary transition. Refund is a separate provider/financial workflow; a contradictory late capture/failure is a reconciliation incident. | Yes | Preserve original evidence, alert/review, and never silently rewrite the outcome. |

`WebhookProcessingStatus` (`RECEIVED`, `PROCESSING`, `PROCESSED`, `FAILED`, `IGNORED`) is an inbox lifecycle, not a payment result. A transient processing failure can return to a retryable received state with `nextAttemptAt`; permanent invalid/unprocessable events become failed or ignored with a safe reason. Neither inbox status nor `ProviderOperationStatus` proves capture.

The existing payment enum lacks a distinct ambiguous/reconciliation state. Phase 2 preserves `CREATED`/`PENDING` for ambiguity, marks only a safe internal `failureCode` (`PROVIDER_OUTCOME_UNKNOWN`), and retains the retryable outbox command. This avoids misusing terminal `FAILED`/`CANCELLED` values or adding an enum migration before provider semantics are known. Reconciliation is recorded through the existing durable event envelope and audit log.

## 5. Webhook verification and processing lifecycle

1. Route receives exact request bytes under a bounded provider-specific raw-body parser. Preserve headers only in request memory for verification.
2. Adapter verifies signature over the exact bytes, validates provider timestamp/replay window where supported, resolves an active signing-key version, and checks provider account scope. Invalid signature: no PaymentAttempt/WebhookEvent state mutation; return a generic client error and record only privacy-safe metrics/security metadata if required.
3. Adapter extracts an allowlisted normalized envelope. Compute a SHA-256 payload digest for conflict detection; do not persist raw body, auth headers or signature.
4. Persist `WebhookEvent` uniquely by `(provider, providerAccountScope, eventId)`, with normalized minimal event data and verification provenance. A duplicate with identical digest is acknowledged without reprocessing. Reuse of an event ID with a different digest is quarantined/alerted and cannot change payment state.
5. Acknowledge only after durable inbox insertion (or confirmed duplicate). If storage is unavailable, return retryable 5xx so the provider can retry. Do not acknowledge an event and then rely solely on in-memory work.
6. Worker claims a bounded lease with an atomic update. In a separate processing transaction it locks `Transaction` first, then `PaymentAttempt`, then revalidates/updates the `WebhookEvent`, outcome history, audit and outbox. Event uniqueness and conditional updates prevent duplicate application.
7. Unknown provider events are safely ignored/quarantined. Delayed/out-of-order events must not regress state. Use provider sequence/occurrence time only if its meaning is documented; otherwise query authoritative provider state. A mismatch becomes reconciliation work.

Secret rotation requires versioned provider webhook credentials and a short overlap during which both explicitly active keys can verify. Persist the key version/identifier used, never the key or signature. Current config exposes only one generic `PAYMENT_WEBHOOK_SECRET`; it is insufficient by itself for auditable overlap/rotation without a provider-specific resolver.

## 6. Initiation and reconciliation flow

The buyer requests an attempt only after seller acceptance and bilateral current-terms approval. The service locks the transaction, rereads active user/authVersion and persisted BUYER participant membership, verifies `ACCEPTED` state and agreed terms, then loads the amount/currency from the transaction. It claims a scoped idempotency operation and atomically creates the attempt, moves `ACCEPTED→AWAITING_PAYMENT` with expected-version compare-and-set, adds status history/audit, and writes the outbox command. No provider call occurs inside that transaction.

A worker creates the provider object using stable idempotency and records its normalized reference/result under the same transaction-first lock order. A timeout after dispatch is ambiguous and must remain nonterminal; a retry queries the provider or reuses the same provider idempotency key. A reconciliation worker scans aged pending/ambiguous attempts, queries the selected provider if supported, records its verified result/provenance, or escalates a safe review case. It never converts elapsed time into failure.

Verified `CAPTURED` updates only the payment attempt and its event/history/audit record in TB-BE-038. It does **not** mark escrow funded or transaction `FUNDED`. TB-BE-061 must consume the verified capture evidence and atomically post a balanced ledger journal, update internal escrow, and transition the transaction only when those records agree. The internal escrow remains an accounting record, not proof of legal custody.

## 7. Cancellation/payment concurrency protocol

All user payment initiation, cancellation, provider-outcome application and any future attempt mutation serialize on the same `transactions` row. Use one lock order:

1. `Transaction` row (`SELECT ... FOR UPDATE`) and re-read status/version/terms.
2. Relevant `IdempotencyOperation` row/key.
3. `PaymentAttempt` rows in stable ID order.
4. `WebhookEvent`/payment history rows.
5. Transaction history, audit and outbox writes.

Never hold a transaction lock while making a provider network request. Webhook/outbox workers may claim their queue lease in a short transaction and release it; the business-processing transaction then acquires the transaction lock first, followed by attempt/event rows, and rechecks lease ownership. This avoids acquiring an event/outbox lock and then waiting on a transaction lock held by cancellation.

Race outcomes:

- Cancellation locks first and safely cancels with no attempt: the later initiation rereads terminal `CANCELLED` and is denied.
- Initiation locks first: it commits an attempt/outbox and `AWAITING_PAYMENT`; cancellation then sees the attempt and is denied.
- Verified terminal no-capture outcome locks first: it records immutable evidence; cancellation can then proceed only if every attempt is verified terminal, none captured/ambiguous, no unmatched provider event/outbox operation remains, and escrow/ledger remain unfunded.
- Cancellation first cannot be undone by a delayed event. A later contradictory capture is quarantined for reconciliation, not silently applied to the cancelled transaction or funds.

Until Phase 2 establishes persisted verified terminal-outcome provenance, preserve TB-BE-050's current rule: **any PaymentAttempt row blocks awaiting-payment cancellation**. Do not infer failure from `FAILED`/`CANCELLED` labels, timeout or missing webhook. Use bounded retries for PostgreSQL serialization/deadlock failures only when the idempotent operation can be safely retried; surface a generic conflict/service-unavailable response otherwise.

## 8. Amount, currency and financial boundaries

- Use `BigInt` integer minor units; serialize amounts as decimal strings. Never use floating point.
- Read agreed amount and ISO currency from persisted transaction/accepted terms under lock. Ignore or reject client amount/currency overrides.
- Compare provider-returned amount, currency, provider account scope, order/payment reference and attempt ID against persisted attempt values exactly before recording a result.
- The composite `(transactionId,currency)` FK and existing positive-amount check are useful; retain them. Add checks for positive attempt amount if the migration history/schema does not already enforce it.
- Any amount/currency/reference mismatch is quarantined and reconciled. Do not “correct” the attempt from the provider response.
- Payment success proves only a provider-reported payment outcome. It does not itself prove escrow funding, legal custody, payout, refund or transaction completion. No escrow ledger, release, refund, payout or dispute decision belongs in this phase.

## 9. API plan

| Endpoint | Authorization / request | Result and boundaries |
|---|---|---|
| `POST /api/v1/transactions/:transactionId/payment-attempts` | Authenticated active BUYER participant; accepted transaction/current bilateral terms; required `Idempotency-Key`; body contains no trusted amount/currency or provider state. Shared account/IP/operation rate limits. | Recommend `202` with safe attempt ID and local status. Same key/fingerprint returns same resource; different fingerprint conflicts. Never return credentials or claim captured/funded. |
| `GET /api/v1/transactions/:transactionId/payment-attempts/:attemptId` | Authenticated BUYER or SELLER participant; verify attempt belongs to that exact transaction. ADMIN has no bypass. | Safe attempt status/reference projection; no provider secrets, webhook contents, payment credentials or unrelated transaction fields. |
| `POST /api/v1/webhooks/:provider` | No user session; provider-specific adapter validates raw bytes/signature, event/account identity and applicable timestamp. Shared endpoint limits plus strict payload bounds. | Generic invalid-signature response; durable accepted/duplicate event gets 2xx only after persistence. Provider retry gets 5xx on storage outage. This route never accepts client payment status. |
| Reconciliation | Internal leased worker; no public endpoint initially. | Query provider only through adapter; record evidence and safe audit/outbox. Human intervention, if later exposed, needs explicit persisted ADMIN authorization and recent TOTP. |

Expected errors include 400 malformed request, 401 missing/invalid user session on participant APIs, 404 concealed nonparticipant/mismatched attempt, 409 transaction/terms/idempotency conflict or unavailable cancellation, 429 shared rate limit, and generic 503 for unavailable persistence/provider dependencies. Webhook responses must follow the selected provider's retry contract without revealing signature details.

## 10. Schema and migration assessment

Existing models provide a useful starting point but are insufficient for auditable verified outcomes and multi-account provider identity. Subject to provider selection, the smallest likely additive changes are:

1. Add `providerAccountScope` to `PaymentAttempt`, backfilled to a documented default; scope provider-reference uniqueness by `(provider, account scope, reference)` so separate merchant accounts cannot collide. Replacing the current unique index requires a reviewed index migration and preflight for duplicate scoped references.
2. Add `PaymentAttemptHistory` (attempt, monotonically increasing version, old/new status, source, provider event/operation reference, verified timestamp, safe reason, created timestamp). Enforce unique `(attempt, version)` and one application per webhook event; preserve old attempt rows with an explicitly unverified legacy history entry. Do not backfill legacy `FAILED`/`CANCELLED` as provider-verified evidence.
3. Extend `WebhookEvent` with payload digest, verified timestamp, provider occurrence timestamp where supplied, and verification-key version/identifier. Keep raw payload and signature out of storage. Existing provider/account/event unique constraint and retry leases remain.
4. If provider order and captured-payment references are distinct, add separate nullable mapped reference columns rather than ambiguously overloading `providerReference`; use scoped uniqueness and safe backfill. Decide after selected adapter contract.
5. Use existing `IdempotencyOperation` and `OutboxEvent`; add a dedicated provider-operation model only if provider status-query/retry provenance cannot be represented safely by those rows plus attempt history. `ProviderOperationStatus` alone is not a record.

Any migration must be additive, retain attempts/events/transaction snapshots, preflight existing duplicates and validate in isolated `trustbridge_test` first. No migration or schema change occurred in Phase 1.

## 11. Security and failure modes

- Never accept frontend redirect/success claims or arbitrary user-supplied provider references as payment evidence.
- Invalid signature, unknown account scope, event ID collision with different payload digest, attempt/reference mismatch, amount/currency mismatch and unsupported event types do not change payment status.
- Provider outage, timeout, webhook delay or missing event remains pending/ambiguous; reconcile before retrying a potentially billable command.
- Use provider-scoped idempotency and database unique constraints; external calls occur outside SQL transactions.
- Log only internal attempt/event IDs, provider code, safe error category and request correlation ID. No raw body, signature, secrets, payment credentials, full provider response or sensitive continuation token.
- Keep operation limits in the shared rate-limit store; do not silently fall back to process-local enforcement in production. Keep feature disabled if the provider/secret resolver is unavailable.
- Provider webhook endpoint authentication is cryptographic verification, not user auth. Do not allow ADMIN role or participant middleware to substitute for signature validation.
- AI, blockchain, client callbacks and transaction status cannot authorize provider outcome, escrow funding or financial execution.
- Production enablement also requires merchant/provider eligibility, jurisdiction/compliance, settlement/custody review, key rotation, monitoring, reconciliation ownership and support procedures. No provider or hosting decision is made here.

## 12. Test plan

- **Unit:** adapter contract, provider capability declaration, exact amount/currency/reference matching, idempotency fingerprint/key reuse, all state transitions, terminal/no-regression policy, unknown/timeout behavior, normalized event validation, signature/timestamp/key-rotation cases, safe error/log redaction and retry classification.
- **HTTP:** authenticated buyer-only initiation; seller read-only access; IDOR and ADMIN non-bypass; no client amount/status/provider-reference override; invalid signature leaves attempt untouched; raw-byte signature exactness; duplicate acknowledgement; bounded body/rate limits; 2xx only after durable inbox persistence; sanitized 4xx/5xx.
- **PostgreSQL (only identity-verified isolated `trustbridge_test`):** two independent clients race idempotent initiation; initiate-vs-cancel; verified terminal failure-vs-cancel; capture-vs-cancel; duplicate same event; same event ID/different digest; out-of-order events; one event cannot double-transition/history; amount/currency mismatch rollback; worker lease reclaim; failure injection proves transaction/history/audit/outbox atomicity. Cleanup only test-owned UUID fixtures; no reset/drop/truncate.
- **Provider:** fake adapter only; no real-money calls, merchant credentials or production webhooks. Real provider contract tests require an approved isolated sandbox account and test keys, never live mode.

## 13. Implementation sequence

1. Resolve provider eligibility, jurisdiction/merchant onboarding, required payment flow, webhook capabilities and refund/cancel semantics; update ADR-005 without assuming Razorpay suitability.
2. Freeze the adapter contract and secret/key-version lifecycle; keep `PAYMENT_ENABLED=false` until required provider and shared dependencies are configured.
3. Review the additive schema plan and write migration-contract tests; apply only to verified `trustbridge_test`, then verify status/catalog/schema diff.
4. Implement provider-neutral fake adapter and domain normalization.
5. Implement buyer-authorized initiation with transaction-first lock, idempotency, attempt/history/outbox transaction, then out-of-transaction provider creation and stable retry handling.
6. Add raw-body webhook capture before JSON parsing, provider verifier, normalized durable inbox, event dedupe and safe acknowledgement.
7. Add leased worker, attempt-state service, monotonic/idempotent event handling, cancellation proof gate and reconciliation/escalation.
8. Complete unit/HTTP/PostgreSQL race/failure tests. Hand off verified `CAPTURED` outcomes to TB-BE-061; do not mark escrow funded in payment code.
9. Complete provider sandbox, deployment-secret rotation, readiness/monitoring and operational review only after provider/platform approval.

## 14. Decisions and blockers

- **No provider selected.** ADR-005 names Razorpay only as a candidate pending eligibility/legal review. Do not install an SDK or enable payment based on that candidate.
- **No hosting/platform selected.** This Phase 1 design does not resume paused TB-BE-035 infrastructure decisions.
- Product must decide whether payment initiation is asynchronous (recommended) and what client continuation data can be exposed safely.
- Provider must document signature algorithm, timestamp/replay guarantees, stable event identity/order, account scoping, idempotency behavior, authoritative status-query capability, definitive no-capture/cancellation evidence and merchant settlement semantics.
- Product/legal must define merchant/custody/settlement model and whether cancellation after verified terminal no-capture is allowed; until then the existing conservative block remains.
- A one-provider-secret environment contract does not define overlapping key rotation. Provider-specific secret versioning/rotation must be designed before enabling webhooks.
- Payment capture must be passed to TB-BE-061 for journal/escrow funding; payment integration alone cannot make a transaction `FUNDED`.

No code, Prisma schema, migration, database data or provider configuration was changed in Phase 1. No payment provider or real-money operation was used.

## 15. Phase 2 implementation and verification (2026-11-04)

Implemented `payment.service.js`, a provider adapter resolver, payment controllers/routes, strict idempotency/body validation, and raw JSON body capture for `/api/v1/webhooks/:provider`. Runtime composition accepts only an injected adapter whose provider ID matches configuration and whose required capabilities are declared. There is no production adapter in the repository; unconfigured or disabled payment integration returns a safe 503 before reserving an attempt. The deterministic HMAC adapter lives under `tests/support`, not production source.

`POST /api/v1/transactions/:transactionId/payment-attempts` is BUYER-participant-only, requires the current user/authVersion and `AWAITING_PAYMENT`, and checks the latest accepted bilateral terms against persisted amount/currency. Its body must be empty; client money, provider refs and status fields are rejected. The transaction row is locked before idempotency, active-attempt, PaymentAttempt, outbox and audit writes. The persisted attempt/outbox is committed before the external adapter call. The provider call is outside the SQL transaction and uses the stable idempotency key. Timeout/invalid/ambiguous results leave `PENDING`, retain retryable outbox work, and never imply failure. The outbox is claimed conditionally with a bounded lease; an expired lease can be reclaimed. Duplicate calls resolve to the same attempt.

`GET /api/v1/payment-attempts/:paymentAttemptId` is participant-only and serializes only ID, status, integer minor-unit amount string, currency and timestamps. `POST /api/v1/webhooks/:provider` receives exact raw JSON bytes via the parser verification hook, verifies through the adapter before persistence, validates normalized fields, checks provider reference/amount/currency, persists only the allowlisted normalized envelope and atomically updates inbox, attempt and audit. Provider-scoped event ID uniqueness makes replay a no-op. Terminal states never regress; contradictory events are quarantined and auditable. A signed failure claim lacking explicit `final=true` and `noCapture=true` is quarantined and leaves the attempt pending. Provider timestamps and event ordering guarantees remain provider-dependent; no signature algorithm is selected beyond the test adapter.

The safe cancellation rule is now transaction-first and checks all attempts. Cancellation is denied unless every attempt is terminal FAILED/CANCELLED and has a processed event with explicit final no-capture evidence, with no failed/processing conflicting inbox event. A provider-signed `FAILED` label alone is insufficient. Initiation, webhook outcomes, reconciliation and cancellation all lock the same Transaction row before mutation. A terminal capture only changes PaymentAttempt; it does not set escrow funded or transition the Transaction. Ledger/escrow funding remains TB-BE-061.

No Prisma schema or migration change was necessary: PaymentAttempt, WebhookEvent, IdempotencyOperation, OutboxEvent and AuditLog support this provider-neutral single-account foundation. Payment status history is captured as redacted append-only-by-policy AuditLog events; a dedicated PaymentAttemptHistory table remains a future schema option if immutable per-attempt history must be queryable independently. Webhook storage is limited to one configured provider account scope (`default`) until account scoping is designed. The service has no background scheduler; a worker must call leased outbox dispatch/reconciliation functions to drive retries. Payments must remain disabled until provider eligibility, merchant/custody/settlement review, account scope, key rotation, provider event-finality semantics, adapter timeouts and worker deployment are approved and verified.

Verification: focused payment + transaction service + HTTP tests passed **27/27** (mock persistence; HTTP tests used local loopback). The opt-in PostgreSQL suite used two independent Prisma clients against read-only-preflight-verified PostgreSQL 17.10 `trustbridge_test` at local port 5432 / IPv6 loopback; **6/6 passed**, including concurrent initiation vs cancellation, duplicate initiation/outbox claim, capture vs cancellation, verified terminal no-capture cancellation and atomic rollback. Preflight confirmed 10/10 migrations applied, no unfinished/failed migrations, and required tables present. Full `npm.cmd test`: **265 passed, 0 failed, 5 skipped** (remaining opt-in suites). Prisma validation, offline dependency listing and changed-JS syntax checks passed. No migration was created/applied; no development or production database was accessed. No real provider, credentials, or payment was used.
# TB-BE-070 — Razorpay adapter implementation note (2026-11-04)

The provider-neutral payment core is retained. `src/services/razorpay-payment.adapter.js` implements the existing adapter contract using fixed HTTPS API endpoints, server-side Basic authentication, bounded fetch timeout, generic errors and strict allowlisted response mapping. The application composes it only for configured `PAYMENT_PROVIDER=razorpay`; payment calls remain disabled by the existing `PAYMENT_ENABLED=false` default. There are no live/test network calls in automated tests.

Order creation uses integer INR paise, an attempt UUID as Razorpay's documented unique `receipt` (max 40 characters), and `GET /v1/orders?receipt=...` before creation and after ambiguous POST errors. Matching existing receipt/amount/currency recovers the provider reference; mismatches or multiple matches fail closed. This is the documented receipt lookup/retry strategy, not a generic idempotency header. Status reconciliation fetches payments for the persisted order and recognizes only a single matching `captured` payment. No payment found stays `PENDING`; this adapter does not claim final no-capture proof, so cancellation remains blocked.

Checkout callback verification uses HMAC-SHA256 over `order_id|payment_id` with the API secret and constant-time comparison, followed by server-side payment fetch and matching persisted order, paise amount and INR. Only then does the service lock the transaction, revalidate current participant/account state and persist a capture event, attempt state and audit record atomically. Webhooks verify HMAC-SHA256 over Express-captured raw bytes using the separate webhook secret; Razorpay `x-razorpay-event-id` is required and persisted under the existing provider-scoped uniqueness. `payment.failed` stays nonterminal because a failed payment try does not prove the order can never be paid. Out-of-order/contradictory events retain core quarantine/reconciliation behavior.

Refund adapter operations use Razorpay's `X-Refund-Idempotency` request header and expose a separate authenticated status fetch. They are disabled by default and require an injected financial-authorization callback; there is no refund HTTP endpoint or integration with TB-BE-039 ledger/approval workflow. Route adapter methods cover documented linked account creation (`POST /v2/accounts`), direct transfers (`POST /v1/transfers` with `X-Transfer-Idempotency`), transfer settlement holds (`PATCH /v1/transfers/:id`) and reversals (`POST /v1/transfers/:id/reversals`). They require both explicit factory enablement and an independent authorization callback; the application does not enable or call them. Razorpay Route eligibility/approval, merchant configuration, legal custody/escrow authorization and settlement terms remain deployment blockers. Capture, transfer acceptance and refund API acceptance never imply escrow funding or TrustBridge transaction completion.

No schema or migration change was needed. Secret rotation overlap, provider event-finality/no-capture evidence, Route account onboarding/KYC, production account approval and live/staging credentials remain operational/provider gates. Refund authorization and ledger coupling remain assigned to TB-BE-039.

Official API references consulted:

- [Create an Order](https://razorpay.com/docs/api/orders/create/) and [Fetch All Orders](https://razorpay.com/docs/api/orders/fetch-all/) for amount subunits, INR, unique receipt and receipt filtering.
- [Fetch a Payment With ID](https://razorpay.com/docs/api/payments/fetch-with-id/) and [Validate and Test Webhooks](https://razorpay.com/docs/webhooks/validate-test/) for server-side payment lookup and raw-body webhook signature verification.
- [Razorpay Route API index](https://razorpay.com/docs/api/payments/route/), [Create a Linked Account](https://razorpay.com/docs/api/payments/route/create-linked-account), [Idempotent Direct Transfer](https://razorpay.com/docs/api/payments/route/direct-transfers-idempotent-request), [Reverse a Transfer](https://razorpay.com/docs/api/payments/route/reverse-a-transfer), and [Modify Settlement Hold](https://razorpay.com/docs/api/payments/route/modify-settlement-hold).
- [Razorpay webhook and idempotency guidance](https://razorpay.com/blog/payment-gateway-webhooks-india/) for event ID, delivery/replay and operation-specific refund idempotency; endpoint eligibility remains subject to account/provider terms.

## TB-BE-039 Phase 2 integration update (2026-11-06)

Refund and Route executors are composed through the normal runtime only when payment provider, master execution and the relevant approval flags are explicitly enabled; all default off. Route account resolution is server-side and required. The supervised outbox/reconciliation worker starts after HTTP listen, prevents overlapping local ticks, drains on shutdown, and relies on persisted DB leases across instances. Route finalization requires matching persisted captured-payment reference, linked account, amount and currency, plus provider `processed` and `settled` status. Mismatched or non-final outcomes do not finalize. No schema change was made in this phase; existing PaymentAttempt captured reference and EscrowOperation provider/lease fields are reused.

Verification: focused payment/escrow tests **76 passed, 0 failed**; isolated PostgreSQL integration **1 passed, 0 failed** with two Prisma clients (duplicate worker lease, ambiguous refund reconciliation, one final ledger journal, transaction finalization and rollback); `npm.cmd test` **304 passed, 0 failed, 6 skipped**; `npx.cmd prisma validate` and `npx.cmd prisma generate` passed. No live provider calls or development/production DB operations. Provider/Route approval, linked-account provisioning and operational/legal gates remain external deployment blockers; financial execution stays disabled by default.
