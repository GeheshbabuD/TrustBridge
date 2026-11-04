# TB-BE-050 — Transaction State Machine Design and Guarded Implementation

**Status:** ADR-010 policy accepted and bounded guarded transitions implemented; TB-BE-050 remains IN PROGRESS pending later payment, dispute, evidence and settlement capabilities. This document does not authorize financial execution or dispute adjudication.

### Phase 2 implementation boundary (2026-11-04)

The service preserves the TB-BE-037 participant transitions and adds a payment-attempt gate to buyer cancellation from `AWAITING_PAYMENT`. Cancellation succeeds only if no `PaymentAttempt` row exists. Because there is no verified provider-outcome workflow, any existing attempt (`CREATED`, `PENDING`, `CAPTURED`, `FAILED` or `CANCELLED`) produces safe HTTP 409 `PAYMENT_OUTCOME_UNVERIFIED`; attempt status alone is not accepted as provider proof. If attempt storage is unavailable, the operation fails closed with 503. A payment-attempt creator added later must lock the same transaction row before inserting, so cancellation and attempt creation serialize.

The service still permits only seller `CREATED→ACCEPTED/REJECTED`, buyer `CREATED→CANCELLED`, buyer `ACCEPTED→AWAITING_PAYMENT`, and buyer `AWAITING_PAYMENT→CANCELLED` with no attempt. Other graph edges—including funding, work progress, delivery, dispute, release, refund and settlement—remain 409-denied until their authoritative service exists. No status change itself executes or proves financial movement. No schema or migration change was needed. Transition retries with the same stale expected version conflict without a duplicate history/audit write; transaction creation retains its existing scoped idempotency replay behavior.

## 1. TB-BE-037 behavior and compatibility

The current implementation creates a transaction as `CREATED`, forces buyer/creator identity from authenticated context, verifies a distinct active USER seller, and creates BUYER/SELLER participant rows. The existing schema has no invite status, so `CREATED` represents the seller invitation. Seller may accept/reject; buyer may cancel a new transaction, move an accepted transaction to `AWAITING_PAYMENT`, or cancel while awaiting payment. Read/list/history routes use persisted participant membership; ADMIN has no ownership bypass.

Creation atomically records transaction, participants, version-1 history, audit and a buyer-scoped idempotency record. Transitions lock the transaction, compare `expectedVersion`, update status/version and append history/audit in one transaction. The isolated PostgreSQL tests verify one-winner same-version transitions and rollback. Preserve these API contracts unless a migration/release plan deliberately replaces them.

Compatibility hazard addressed in Phase 2: `AWAITING_PAYMENT → CANCELLED` must reject when any PaymentAttempt exists. This implementation has no provider-outcome verifier, so even persisted `FAILED` or `CANCELLED` attempt status is not accepted as proof of a verified terminal outcome. A later payment module may enable cancellation only through a verified durable provider outcome. No timeout, client response or missing webhook implies failure. Payment failure remains a PaymentAttempt state, never a transaction `FAILED` state.

## 2. Proposed transaction state graph

```text
CREATED ──seller accepts──> ACCEPTED ──buyer starts payment──> AWAITING_PAYMENT
   │                           │                                     │
   ├─seller declines─> REJECTED ├─────────────────────────────────────┤
   └─buyer cancels───> CANCELLED                          verified capture + funding
                                                                  │
                                                                  v
                                                               FUNDED
                                                                  │
                                                    seller starts │ buyer/seller disputes
                                                                  v
                                                            IN_PROGRESS
                                                                  │
                                              seller delivers    │ dispute
                                                                  v
                                                              DELIVERED
                                                                  │
                                              buyer confirms     │ dispute
                                                                  v
                                                          RELEASE_PENDING
                                                                  │ verified payout
                                                                  v
                                                              COMPLETED

FUNDED / IN_PROGRESS / DELIVERED ──authorized dispute opening──> DISPUTED
DISPUTED ──review outcome──> IN_PROGRESS | RELEASE_PENDING | REFUND_PENDING
FUNDED ──approved refund authorization──────────────────────────> REFUND_PENDING
REFUND_PENDING ──verified refund────────────────────────────────> REFUNDED
AWAITING_PAYMENT ──safe cancellation (no capture)───────────────> CANCELLED
```

Terminal states: `REJECTED`, `CANCELLED`, `COMPLETED`, `REFUNDED`. No outgoing transitions. `FUNDED`, `IN_PROGRESS`, `DELIVERED`, `DISPUTED`, `RELEASE_PENDING` and `REFUND_PENDING` are not client-assignable statuses. No API may transition directly to `COMPLETED` or `REFUNDED` based on client, AI or blockchain claims.

## 3. Transition and evidence matrix

All human transitions require an active authenticated account and current persisted participant membership whose role agrees with `buyerId`/`sellerId`. Each successful state change increments `Transaction.version`, conditionally updates the locked row, appends one immutable-by-policy `TransactionStatusHistory` entry and a redacted `AuditLog` record in the same transaction. A duplicate request is idempotent or conflicts by operation key/version; it must never append duplicate history.

| Transition | Authorized actor and preconditions | External/escrow evidence | Fresh MFA/step-up | Failure/retry boundary |
|---|---|---|---|---|
| Create → `CREATED` | Active buyer USER creates; seller must be a distinct existing active USER. Terms, amount and currency are validated. | None. Initial status is not payment. | No, subject to account policy. | Required scoped idempotency key; create transaction, both participant rows, initial history and audit atomically. Retry returns same resource for same fingerprint. |
| `CREATED` → `ACCEPTED` | Persisted SELLER participant accepts the current terms. | None. | No. | Expected-version update; retry returns already-accepted result only for matching operation/version, otherwise conflict. |
| `CREATED` → `REJECTED` | Persisted SELLER participant declines. | None. | No. | Terminal; atomically record reason and history. |
| `CREATED` → `CANCELLED` | BUYER participant cancels before acceptance/payment. | No provider attempt or capture may exist. | No. | Terminal; duplicate cancel is idempotent. |
| `ACCEPTED` → `AWAITING_PAYMENT` | BUYER participant explicitly begins payment. | Creates/reuses a provider payment attempt; this status means payment is awaited, not received. | Product decision: provider confirmation/strong customer authentication belongs to provider flow. | Per-transaction idempotency key; payment-attempt creation/outbox should be atomic. Provider retry cannot create a second charge. |
| `AWAITING_PAYMENT` → `FUNDED` | Verified payment service/webhook worker only. | Verify provider signature/event, attempt and transaction references, amount and currency; mark the PaymentAttempt captured, post balanced ledger funding, update internal Escrow to FUNDED, then transaction status in one DB transaction. Escrow remains an accounting record, not legal custody. | No user TOTP; provider verification and service identity are authoritative. | Provider-scoped event uniqueness and operation idempotency; duplicate/out-of-order events reconcile without double posting. On mismatch quarantine and do not transition. |
| `AWAITING_PAYMENT` → `CANCELLED` | Buyer participant; permitted now only when no PaymentAttempt row exists. | Any existing attempt blocks in this phase. A later payment module must establish a verified terminal provider outcome; escrow must remain UNFUNDED. | No. | Safe 409 `PAYMENT_OUTCOME_UNVERIFIED` when an attempt exists; 503 on unavailable attempt storage. No timeout, frontend result or absent webhook is proof of failure. Future attempt writers must take the transaction row lock. |
| `FUNDED` → `IN_PROGRESS` | SELLER participant starts performance after funding. | Require internal funding journal and matching funded escrow balance/status. No additional provider event. | No. | Versioned participant transition; duplicate start is idempotent. Funding mismatch blocks and raises reconciliation work. |
| `FUNDED` / `IN_PROGRESS` / `DELIVERED` → `DISPUTED` | Either persisted participant opens a dispute with category and description. | Create a real Dispute row; evidence is separate, private metadata, authorized through dispute→transaction. No payment result is inferred. | No step-up proposed for opening; rate limits and audit apply. | Lock transaction and enforce the agreed single-active-dispute policy; create dispute, transition, history and audit atomically. Retry by idempotency key. |
| `FUNDED` → `REFUND_PENDING` | Authorized refund policy/reviewer; preferably only after an approved dispute or explicit documented cancellation/refund rule. Buyer/seller cannot self-assert refund authorization. | Create durable refund authorization; preserve escrow/ledger balance until provider result. No provider refund yet. | Fresh TOTP step-up for human privileged authorization. | Idempotent full remaining-balance authorization; partial refund allocation is out of scope until separately designed. Provider failure leaves operation pending/failed and does not claim REFUNDED. |
| `IN_PROGRESS` → `DELIVERED` | SELLER participant records completion/delivery. | Delivery evidence requirements and permitted content need product decision. Current Evidence model is dispute-scoped, not delivery-scoped. | No, unless policy later classifies delivery as a sensitive action. | Versioned, idempotent completion; duplicate delivery must not duplicate history. |
| `DELIVERED` → `RELEASE_PENDING` | BUYER participant confirms acceptance and authorizes release under the agreed policy. | Require funded escrow, balanced posted funding journal, and a distinct durable release authorization. Does not issue payout or complete the transaction. | Recommend fresh purpose-bound TOTP step-up for the buyer’s release authorization; define fallback for USER accounts without MFA. | One-time authorization + idempotency; transaction, authorization, escrow state, history, audit and outbox commit atomically. Provider work is retried independently. |
| `DISPUTED` → `IN_PROGRESS` | Authorized human resolver closes dispute with resume outcome and reason. | Resolution record and reviewed evidence; no financial action. | ADMIN role from DB plus fresh TOTP/step-up. | Resolution and transition atomic; duplicate resolution conflicts/idempotently returns recorded outcome. AI is advisory only. |
| `DISPUTED` → `RELEASE_PENDING` | Authorized human resolver chooses release after review. | Durable resolution and release authorization; funded escrow/ledger must still reconcile. Provider payout has not occurred. | ADMIN DB role plus fresh TOTP/step-up; preserve participant ownership checks for parties. | Atomic resolution/authorization/history/audit/outbox; one operation key. |
| `DISPUTED` → `REFUND_PENDING` | Authorized human resolver chooses refund after review. | Durable resolution and refund authorization; no provider refund is asserted yet. | ADMIN DB role plus fresh TOTP/step-up. | Atomic, idempotent full-balance authorization; provider failure cannot change transaction to REFUNDED. |
| `RELEASE_PENDING` → `COMPLETED` | Provider-operation processor only after verified payout success. | Verify provider result/reference/amount/currency; post balanced release ledger journal and mark internal escrow RELEASED atomically. | No user MFA; verified provider outcome is required. | Unique provider operation/event; repeated success is idempotent. Ambiguous outcome is reconciled, not retried blindly. |
| `REFUND_PENDING` → `REFUNDED` | Provider-operation processor only after verified refund success. | Verify provider result/reference/amount/currency; post balanced refund journal and mark escrow REFUNDED atomically. | No user MFA; verified provider outcome is required. | Unique operation/event; ambiguous or failed provider result stays pending/reconciliation state, never marks refunded. |

For every transition, include actor (nullable only for system event), prior/new state, version, safe reason code and timestamp. Never place secrets, raw provider payload, credentials, card data, private evidence or arbitrary sensitive metadata in history/audit/outbox.

## 4. Actor authorization matrix

| Actor | Allowed | Explicitly not allowed |
|---|---|---|
| Buyer participant | Create own transaction; cancel before acceptance or safely before capture; initiate payment; open dispute; confirm delivery/release only with dedicated authorization. | Mark payment captured/funded, set seller identity, assert provider success, bypass dispute review, or mutate arbitrary status. |
| Seller participant | Accept/reject invitation; start work after verified funding; record delivery; open dispute. | Cancel as buyer, assert funding, authorize release/refund or resolve their own dispute. |
| ADMIN | Separate, audited dispute resolution with persisted ADMIN role, case authorization and fresh TOTP step-up. | Implicit participant access, arbitrary transaction mutation, self-approved ownership, or marking provider outcomes. |
| Verified provider/webhook worker | Record normalized verified capture/cancel/payout/refund outcomes and trigger corresponding guarded service transition. | Trust unsigned client claims, bypass amount/currency/idempotency checks, decide disputes. |
| AI/blockchain subsystem | Supply advisory risk signals or independently verifiable reference evidence. | Transition transaction state or authorize any payment, release, refund or dispute outcome. |

## 5. State separation and API/service plan

Keep four state machines distinct:

- **Transaction:** commercial workflow state in `TransactionStatus`.
- **Payment attempt:** provider charge attempt (`CREATED`, `PENDING`, `CAPTURED`, `FAILED`, `CANCELLED`); failure is not transaction failure.
- **Escrow/internal ledger:** `UNFUNDED`, `FUNDED`, release/refund pending, `RELEASED` or `REFUNDED`; never a custody claim. Ledger journals remain append-only and balance per currency.
- **Dispute:** `OPEN`, `UNDER_REVIEW`, `RESOLVED`, `CLOSED`; resolution does not itself prove payment execution.

Proposed API surface: keep TB-BE-037 create/list/detail/history; expose participant commands as action endpoints (`accept`, `reject`, `cancel`, `start`, `deliver`, `confirm`, `disputes`) rather than a public arbitrary-status setter. Payment-attempt initiation belongs to the payment module; verified provider webhooks are separate. Admin dispute resolution is a separate MFA-protected route. Provider payout/refund execution is internal worker/service only. All controllers validate and delegate; a pure state policy validates transition + actor; lifecycle services own locked transaction, authorization/evidence checks, status history, audit and outbox writes.

## 6. Schema compatibility and migration assessment

The existing `TransactionStatus` enum already contains the proposed lifecycle states; `PaymentAttemptStatus`, `EscrowStatus`, `DisputeStatus`, and `ProviderOperationStatus` are distinct. Existing `TransactionStatusHistory` has nullable previous state, actor, reason, timestamp, unique `(transactionId,version)` and chronology indexes. `AuditLog`, `IdempotencyOperation`, `WebhookEvent` and `OutboxEvent` provide foundations. `PaymentAttempt` includes transaction/currency, provider/reference, unique transaction-scoped idempotency key and status; `Escrow` is unique per transaction/currency; Dispute and private Evidence metadata have actual relations.

No enum change is currently justified. Service-level row locks/conditional version updates and atomic history/audit/outbox writes are required regardless of schema. Potential additive schema needs, subject to approved policy: (1) durable release/refund authorization records because no authorization model exists; (2) provider payout/refund operation records because `ProviderOperationStatus` is only an enum and no operation model currently exists; (3) explicit capture/settlement timestamps or event references if event rows alone are insufficient; (4) delivery-evidence relation if delivery proof is mandatory; (5) a partial unique active-dispute constraint if one-active-dispute policy is approved. Do not add any until decisions and service ownership are settled.

Migration risks: history currently permits multiple Dispute rows per transaction and has no active-dispute uniqueness. Any new unique constraint needs a preflight for existing duplicates and a non-destructive backfill/cleanup decision. Adding authorization/provider-operation tables should be additive with nullable/initial lifecycle fields and restrictive FKs; never rewrite existing financial history. Existing TB-BE-037 creation/transition semantics and history version numbering must remain compatible. The current `AWAITING_PAYMENT → CANCELLED` path must gain payment-attempt preconditions before payment endpoints ship.

## 7. Security risks and controls

- Frontend status and participant IDs are untrusted. Derive actor from verified auth and re-read participant/current account under lock; keep Admin separate from participant policy.
- Payment confirmation only from signature-verified, provider-scoped durable events with matching transaction/attempt/amount/currency. Deduplicate and reconcile out-of-order events.
- Commit state, ledger, escrow, idempotency, history, audit and outbox together where they represent one local decision. Use provider idempotency and reconciliation for external side effects; do not hold DB transactions open during network calls.
- TOTP step-up protects release/refund authorization and admin resolution, not routine progress. Define an explicit policy for non-MFA USER accounts before release confirmation.
- Evidence storage references are not access capabilities. Gate reads by participant/dispute relationships, signed short-lived delivery if later implemented, and audit access.
- Concurrency uses transaction row locks in consistent order plus version compare-and-set and DB uniqueness. Audit/history are append-only by service policy; DB grants/triggers are still needed to enforce immutability against alternate writers.
- AI remains advisory; blockchain state/hash alone is never authorization or payout evidence.

## 8. Validation plan and implementation sequence

Unit: table-driven test every permitted and forbidden edge, actor-role matrix, terminal states, amount/currency invariants, payment/escrow evidence gates, reason allowlists, out-of-order events, duplicate idempotency and retry semantics. HTTP: authentication, participant IDOR, no admin bypass, action-specific schemas, no arbitrary status endpoint, safe serialization and no security/payment internals. PostgreSQL on only verified isolated `trustbridge_test`: independent-client races for two transitions, capture event replay, cancellation versus capture, duplicate dispute opening, release/refund authorization, history uniqueness, and injected failures proving rollback across transaction/payment/escrow/ledger/history/audit/outbox. Never fake provider success as a production integration result.

Recommended order:

1. **TB-BE-050-A:** ADR-010 decisions accepted; see the accepted policy above and remaining decisions below.
2. **TB-BE-050-B (bounded implementation):** guarded transitions implemented with unit/HTTP and isolated PostgreSQL tests; financial/dispute/evidence edges remain denied.
3. **TB-BE-051/052/053:** invitation/terms acceptance, participant progress, delivery, cancellation and history routes with ownership and real PostgreSQL tests.
4. **TB-BE-070/072 then TB-BE-060/061:** provider attempt/event verification and balanced funding/escrow transition; webhook, idempotency and ledger atomicity tests.
5. **TB-BE-080/081/082:** dispute lifecycle, private evidence controls and MFA-protected human resolution.
6. **TB-BE-062 then TB-BE-073/074/075:** durable release/refund authorization, provider execution, payout/refund confirmation and reconciliation. Final states only after verified outcomes.

## 9. Resolved decisions and remaining implementation gates

ADR-010 is accepted with the user-approved policy: pending/captured attempts block cancellation; any existing attempt blocks it until verified provider outcome support exists; disputes block ordinary completion/release and only an authorized human workflow may resolve them; AI is advisory; transaction state never performs or proves release/refund; evidence is private references/metadata with ownership, validation and audit; timeout only triggers notification/review; sensitive administrative decisions require recent TOTP, not recovery-code assurance. Financial release/refund assurance and execution belong to TB-BE-039. No provider call, dispute adjudication, escrow posting, release or refund is implemented here.

Remaining product/security decisions before the corresponding modules: seller invitation expiry/withdrawal; sequential versus one-active dispute policy (schema permits multiple); dispute resolver dual control; delivery evidence type and requiredness; buyer response period (without auto-acceptance); refund authorization policy and partial-refund scope; policy for release step-up for USER accounts without MFA; provider retry, ambiguous outcomes and reconciliation escalation. These do not authorize weakening the fail-closed gates in this phase.
