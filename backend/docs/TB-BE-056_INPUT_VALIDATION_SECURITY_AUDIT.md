# TB-BE-056 — API Input Validation and Resource-Boundary Security Audit

**Scope:** source and focused-test review only. No tests, database operations, provider calls, or code changes were performed. Validation is implemented primarily in controllers through Zod `safeParse`, rather than through the currently empty `src/middleware/validate.middleware.js`.

## Findings

### MEDIUM — One-time step-up grants can be consumed before request validation

- **Affected routes/files:** `src/routes/dispute.routes.js` (`POST /admin/disputes/:disputeId/review`, `POST /admin/disputes/:disputeId/resolve`); `src/routes/auth.routes.js` (legacy ADMIN enrollment `authorize`, `identity`, and `approval` endpoints).
- **Verified behavior:** Step-up middleware runs before the controller. The dispute controller then validates the UUID and, for resolution, the strict body. The legacy ADMIN controllers validate bodies only after step-up; the request ID is not schema-validated before the middleware uses it as the grant resource. These are one-time purpose grants. A malformed request can therefore spend a valid grant and then receive a validation error. This does not bypass authorization; it creates avoidable grant-burn/availability behavior.
- **Test coverage:** `tests/integration/dispute.test.js` verifies separate step-up purposes and strict dispute creation, but does not assert malformed review/resolution inputs leave the one-time grant unused. No focused legacy ADMIN malformed-input/grant-consumption assertion was located in the inspected routes/tests.
- **Impact:** A caller with a valid grant can accidentally or deliberately invalidate that grant with malformed input, requiring a new TOTP step-up. It can also complicate client retries.
- **Minimal correction:** Validate path, body, and relevant headers before one-time step-up middleware, retaining all existing role, purpose/resource binding, ownership, and service checks. Add regression tests asserting malformed requests do not consume the grant.

### LOW — Shared validation middleware is an empty, unused placeholder

- **Affected file:** `src/middleware/validate.middleware.js` (0 bytes); controllers under `src/controllers/` perform their own parsing.
- **Verified behavior:** The inspected controllers generally call explicit schemas and return the common validation error. Route ordering differs: some input checks occur in controllers, while `src/routes/escrow.routes.js` validates before step-up. This decentralization produced the MEDIUM ordering issue above. No evidence in the inspected endpoints showed raw request-body spreading into persistence.
- **Test coverage:** Focused validator and HTTP tests cover representative inputs, including `tests/unit/transaction-validator.test.js`, `tests/unit/user-validation.test.js`, `tests/unit/auth-validation.test.js`, and `tests/integration/dispute.test.js`. There is no common middleware contract test because the middleware is empty and unused.
- **Impact:** Validation order and coverage are easier to make inconsistent as routes evolve; by itself, the empty middleware is not an input-validation bypass.
- **Minimal correction:** Either remove the unused placeholder or implement a small schema middleware and adopt it selectively for route-level params/headers/body validation. Avoid broad refactoring; preserve controller/service validation at trust boundaries.

## Verified controls in inspected areas

- **Strict bodies and mass assignment:** Transaction, terms, invitation, dispute, profile, payment, escrow, and MFA schemas use strict Zod object schemas. Controllers pass parsed data to services in the inspected write paths. `src/services/user.service.js` merges validated preference data with stored preferences; no raw request object merge was found in the focused paths.
- **Money and identifiers:** Transaction amounts are decimal integer strings bounded to PostgreSQL signed BIGINT before `BigInt` conversion; currencies are uppercase ISO-style codes checked against the runtime currency list. Dispute partial-refund amounts are bounded decimal strings. Resource identifiers generally use UUID schemas. Pagination limits are bounded (commonly 1–100), and enum/state inputs use explicit allowlists. These checks do not authorize a state transition; services remain responsible for transition policy.
- **Nested payloads:** Transaction terms bound individual strings and arrays and enforce depth, node-count, key-length, and serialized-size limits. The application JSON parser is capped at 1 MB (`src/app.js`); form parsing is also capped with a parameter limit.
- **Evidence:** Upload routes accept a fixed MIME allowlist as raw bytes with a 10 MB parser cap. `src/services/transaction-delivery.service.js` and the dispute evidence service validate buffer size, content type against file signatures, category, and sanitized filename before storing opaque references and hashes. This audit did not open private evidence. `tests/integration/dispute.test.js` and `tests/integration/transaction-delivery.test.js` cover upload constraints and safe responses.
- **Webhook boundary:** `src/app.js` preserves raw request bytes for webhook routes. Payment service validates the normalized event ID against a bounded 1–255 character allowlist before persistence; Razorpay adapter validates provider references and signatures. The HTTP layer validates provider path and raw-body presence. `tests/unit/razorpay-payment.adapter.test.js` and `tests/integration/payment.test.js` cover signature/raw-body and malformed-event behavior.
- **Errors and authorization boundary:** Controllers use generic validation errors; unexpected errors are sanitized by shared error handling. Ownership and role middleware/services remain separate from parsing. Validation alone does not establish transaction participation, user ownership, ADMIN authority, MFA assurance, or permission to transition state.
- **Prototype pollution:** Strict schemas and use of parsed allowlisted values reduce exposure in reviewed write paths. No unsafe merge of raw request data was identified in this focused review. This is not a repository-wide proof that every object construction is pollution-safe.

## Coverage and limitations

Focused tests exist for auth, profile, transaction, payment, dispute, and evidence validation. The audit did not execute them, inspect every controller or service, or prove every route validates every header/path/query combination. In particular, add route-level coverage for malformed path/body/header input before single-use authorization. No database or provider behavior was exercised.

## Prioritized remediation

1. **P1:** Move complete schema validation ahead of one-time step-up on dispute review/resolution and legacy ADMIN recovery routes; test grant preservation on invalid input.
2. **P2:** Establish a consistent route validation convention for params, query, headers, and body; retire or implement the empty validation middleware.
3. **P3:** Extend focused route-contract tests for strict unknown-field rejection, pagination boundaries, header limits, BigInt boundaries, and generic validation errors across the API families.

No external decision or provider approval blocks these input-validation corrections. Authorization, recovery policy, provider capabilities, and evidence access policy remain governed by their existing security controls and are outside this audit's proposed changes.
