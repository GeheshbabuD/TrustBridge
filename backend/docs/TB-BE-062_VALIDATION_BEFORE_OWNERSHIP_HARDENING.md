# TB-BE-062 — Validation-Before-Ownership Hardening

**Status:** Implemented and verified. This task addresses the confirmed LOW-severity ordering findings in TB-BE-061. Validation remains syntactic preflight; authentication, RBAC, ownership, resource binding, controller validation, and service authorization remain authoritative.

## Route changes

- **Transactions:** strict UUID preflight before participant lookup on `GET /transactions/:transactionId`, `/history`, `/terms`, `/deliveries`; terms version proposal/decision, invitations, transitions, work start, delivery submission/decision, and delivery-evidence upload validate existing request schemas first. History pagination is checked before ownership lookup. Delivery-evidence transaction/delivery IDs, content type, and category are checked before ownership; raw file parsing remains after participant authorization.
- **Payments:** initiation validates transaction UUID, empty JSON body, and idempotency header before buyer ownership lookup. Attempt retrieval validates attempt UUID before ownership. Callback verification validates UUID and existing callback body schema before attempt ownership lookup.
- **Escrow:** `GET /transactions/:transactionId/escrow` validates the transaction UUID before participant lookup. Existing release/refund ordering is unchanged.
- **Disputes/evidence:** dispute creation validates transaction UUID, strict body, and idempotency header before participant lookup. Dispute detail/response/evidence and participant evidence download validate resource UUIDs before ownership lookup. Evidence content type/category are preflighted before ownership; raw bytes are still parsed only after participant authorization. ADMIN evidence binding validates role then evidence UUID before the binding query and existing step-up gate.
- **Notifications:** mark-read validates notification UUID before recipient lookup.

Existing controller validation remains in place as defense in depth. Generic validation errors remain `400 VALIDATION_ERROR`; invalid evidence MIME/category retain their established error codes (`EVIDENCE_INVALID` for MIME, `VALIDATION_ERROR` for category). Ownership failures remain masked as not found. No schema, migration, dependency, service, or financial behavior changed.

## Regression coverage

`tests/integration/validation-before-ownership.test.js` uses lookup counters to verify malformed transaction/history/payment/escrow/dispute/evidence/admin-evidence/notification inputs do not reach ownership or binding lookups. It also verifies valid-format non-owner requests retain masked denial and do not reach protected service methods. Existing route suites continue to cover successful authorized operations, participant checks, ADMIN role/step-up, and safe evidence handling.

## Verification

- Focused command: `node --test tests/integration/validation-before-ownership.test.js tests/integration/transaction.test.js tests/integration/payment.test.js tests/integration/escrow.test.js tests/integration/dispute.test.js tests/integration/notification.test.js` — **19 passed, 0 failed**.
- Full command: `npm.cmd test` — **418 passed, 0 failed, 11 skipped** (429 total tests/subtests).
- The initial sandboxed focused run failed before assertions because loopback `fetch` was unavailable. The same focused tests passed with loopback networking enabled; no application workaround was added.
- No databases, external providers, secrets, or migrations were accessed.

## Remaining risks

TB-BE-061’s broader low-severity observations outside the scoped routes remain unchanged. This change establishes syntax-before-lookup ordering; it does not replace authorization or prove database-level behavior.
