# TB-BE-061 — Validation-Before-Ownership Audit

**Scope:** focused, read-only review of resource route ordering, existing Zod schemas, ownership middleware, controllers, and directly related HTTP tests. No tests or external systems were run/accessed.

## Findings

### LOW — Transaction participant routes query before validating the transaction ID

- **Routes:** `GET /transactions/:transactionId`, `/history`, `/terms`; `POST /transactions/:transactionId/terms/versions`, `/terms/decisions`, `/invitations`, `/transitions`, `/work/start`, `/deliveries`, `/deliveries/decision`, and `/deliveries/:deliveryId/evidence`; `GET /transactions/:transactionId/deliveries`; `POST /transactions/:transactionId/disputes`.
- **Evidence:** `src/routes/transaction.routes.js` places `requireTransactionParticipant` before each controller. In `src/middleware/ownership.middleware.js`, the middleware accepts any nonempty string and calls `transaction.findUnique` before `src/controllers/transaction.controller.js` validates UUID syntax. For `/history`, it also performs that ownership lookup before the controller checks `transactionHistoryQuerySchema`. The evidence-upload controller validates both path IDs and category only after participant middleware, content-type check, and bounded raw-body parsing.
- **Coverage:** `tests/integration/transaction.test.js` covers participant access and validation as outcomes but does not assert invalid IDs/queries avoid the ownership lookup. `tests/integration/transaction-delivery.test.js` covers file handling, not validation-before-ownership ordering.
- **Impact:** Malformed IDs and invalid history pagination cause unnecessary Prisma/ownership work; malformed upload metadata/path can be rejected only after bounded upload parsing. A Prisma argument/UUID failure is forwarded and may become a sanitized generic 500 rather than the normal 400. This is not an ownership bypass.
- **Minimal correction:** After authentication (and role where applicable), run `validateRequest` with strict transaction and delivery parameter schemas; add the history query schema on `/history`; preflight evidence category/content-type syntax before the resource lookup. Keep `requireTransactionParticipant` and existing file parser/service byte validation in the chain. Keep raw upload parsing after authorization to avoid reading files from unauthorized callers.

### LOW — Payment ownership lookups precede path, body, and header validation

- **Routes:** `POST /transactions/:transactionId/payment-attempts`; `GET /payment-attempts/:paymentAttemptId`; `POST /payment-attempts/:paymentAttemptId/verify`.
- **Evidence:** `src/routes/payment.routes.js` runs `requireTransactionParticipant` or `requirePaymentAttemptParticipant` before `src/controllers/payment.controller.js`. The middleware queries on the raw path ID. The controller then validates payment-attempt/transaction UUIDs, the callback body, idempotency key, and empty initiation body.
- **Coverage:** `tests/integration/payment.test.js` covers callback/signature and participant behavior; it does not assert malformed values are rejected before the ownership lookup.
- **Impact:** Invalid IDs or callback bodies can trigger unnecessary resource queries, with a possible generic 500 on Prisma UUID validation errors. The existing ownership middleware masks non-owned resources as 404 and does not trust client ownership claims.
- **Minimal correction:** Add strict params schemas using existing `paymentAttemptIdSchema` and a single transaction-ID schema before the ownership middleware. For initiation also validate the empty body and idempotency header before lookup. The current shared middleware supports only body/query/params, so header preflight requires a small route-local check using `paymentIdempotencyKeySchema` or a separately approved extension; do not silently omit it. Retain participant middleware and controller/service checks.

### LOW — Escrow status lookup precedes transaction-ID validation

- **Route:** `GET /transactions/:transactionId/escrow`.
- **Evidence:** `src/routes/escrow.routes.js` runs `requireTransactionParticipant` before `escrow.controller.status` parses `escrowTransactionIdSchema`. Release/refund already validate body, idempotency header, and transaction ID before ownership/step-up; no finding for those mutations.
- **Coverage:** `tests/integration/escrow.test.js` verifies ownership/step-up behavior but does not check invalid-ID lookup ordering.
- **Impact:** Malformed ID reaches the transaction lookup first; no authorization bypass is indicated.
- **Minimal correction:** Apply a strict `transactionId` params schema before `requireTransactionParticipant`; keep the ownership check unchanged.

### LOW — Participant dispute/evidence lookups precede syntax and metadata validation

- **Routes:** `POST /transactions/:transactionId/disputes`; `GET /disputes/:disputeId`; `POST /disputes/:disputeId/responses` and `/evidence`; `GET /dispute-evidence/:evidenceId`; `GET /admin/dispute-evidence/:evidenceId`.
- **Evidence:** `src/routes/dispute.routes.js` places `requireTransactionParticipant`, `requireDisputeParticipant`, or `requireEvidenceParticipant` before controller ID/body validation. The ownership middleware queries Prisma by the raw ID. The admin evidence route calls `bindEvidenceDispute` (database lookup) before controller UUID validation. On evidence upload, the participant lookup precedes category validation; raw file parsing is bounded to 10 MB. Admin dispute detail/review/resolution and AI assistance are already prevalidated before their one-time step-up paths from TB-BE-059/060 and are not findings here.
- **Coverage:** `tests/integration/dispute.test.js` covers ownership, request validation, and evidence type handling but does not assert no lookup occurs for malformed resource IDs or metadata.
- **Impact:** Invalid IDs can reach resource lookups and may lead to sanitized 500/503 responses. Invalid evidence metadata can be rejected after the ownership lookup and, for category validation, after bounded raw parsing. Access control remains enforced by ownership/service checks.
- **Minimal correction:** Reuse `disputeParamsSchema` and add analogous strict wrappers around existing dispute/evidence UUID validators before ownership/binding lookups. Validate dispute-create body/idempotency header and evidence category/content-type metadata before lookup. Preserve authentication and ADMIN role checks first; retain all participant/administrator authorization and keep evidence byte parsing and content inspection behind authorization.

### LOW — Notification ownership lookup precedes notification-ID validation

- **Route:** `PATCH /notifications/:notificationId/read`.
- **Evidence:** `src/routes/notification.routes.js` runs `requireOwnNotification` before `notification.controller.markRead` validates `notificationIdSchema`. The middleware queries by any nonempty string before checking recipient ownership.
- **Coverage:** `tests/integration/notification.test.js` verifies cross-user denial but does not test malformed-ID lookup ordering.
- **Impact:** Malformed IDs trigger unnecessary lookup and can result in a generic storage error; the recipient check still protects ownership.
- **Minimal correction:** Add a strict notification params schema before `requireOwnNotification`, retaining the ownership middleware.

## Routes with adequate ordering for this audit

- `GET /sellers` validates `sellerLookupQuerySchema` after authentication and before the query service (`src/routes/marketplace.routes.js`, TB-BE-060).
- Admin transaction/dispute list filters are parsed in controllers after reusable recent-TOTP checks, but those checks are not ownership/resource lookups; no ownership-ordering defect was confirmed.
- Transaction delivery evidence download validates its evidence ID in the controller before invoking the delivery service. The service remains responsible for access control.
- Escrow release/refund validation precedes ownership/step-up and is already covered by route-level checks.
- TB-BE-059/060 step-up ordering fixes are preserved; no regression was found in the inspected route definitions.

## Recommended priority and adoption

1. **P1 (LOW severity):** Preflight transaction IDs and history pagination before participant lookup; include delivery ID and evidence metadata preflight while keeping raw-file parsing after authorization.
2. **P1 (LOW severity):** Preflight payment IDs, initiation/callback body, and idempotency header before participant lookup.
3. **P2 (LOW severity):** Preflight dispute/evidence and notification IDs before their ownership/binding queries; validate dispute/evidence metadata before queries.
4. **P2 (LOW severity):** Preflight escrow status transaction ID. Keep existing release/refund ordering.

Use `validateRequest` for body/query/params only where an existing strict schema or a small reusable params wrapper is available. Do not put a client-supplied ID into authorization state, treat schema validity as permission, or remove the ownership/role/service check. If schemas transform/default query values, controllers may continue parsing them until a separate, tested migration adopts `request.validatedRequest` consistently.

Add HTTP regressions with a lookup counter: malformed syntax should return the existing generic 400 and make zero ownership/resource calls; valid-format IDs for non-owned resources must continue to return the existing masked denial and never reach protected services. No external decision or infrastructure blocker was identified. This audit did not verify the exact runtime error produced by a live database for malformed UUID inputs.

## Progress

Assessment only; no task tracker/log update was necessary. No code, tests, schema, migration, dependency, or database changes were made.
