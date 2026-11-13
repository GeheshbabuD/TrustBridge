# TB-BE-060 — Shared API Validation Middleware

**Status: IMPLEMENTED AND VERIFIED.**

## Middleware contract

`src/middleware/validate.middleware.js` exports `validateRequest({ body, query, params })`. Each configured value must be a Zod-compatible schema with `safeParse`. It validates only configured sections, uses `{}` for an absent body to preserve current optional/empty-body route behavior, and stores successful parsed values in `request.validatedRequest` without mutating raw `request.body`, `request.query`, or `request.params`. Unknown configuration sections and invalid/missing schema configuration fail immediately at route construction.

Invalid input is forwarded as `ApiError(400, "VALIDATION_ERROR", "Request validation failed")`; shared error handling continues to omit Zod details. Schemas remain the existing domain schemas. `disputeParamsSchema` composes the existing dispute UUID schema, and AI controllers/routes share one strict empty-request-body schema. No generic header or raw upload-body parsing was added.

## Adopted routes

- `POST /api/v1/auth/mfa/recovery-codes/regenerate` — existing strict empty MFA body before one-time step-up.
- `POST /api/v1/auth/mfa/disable` — same empty-body preflight before one-time step-up.
- `GET /api/v1/admin/disputes/:disputeId` — UUID preflight before one-time review step-up.
- `POST /api/v1/admin/disputes/:disputeId/assistance` — UUID and strict empty-body preflight before one-time review step-up.
- `GET /api/v1/sellers` — existing seller lookup query schema before query service invocation.

Controllers retain their validation as defense in depth. Authentication, role checks, rate limiting, persisted grant purpose/resource binding, TOTP assurance, expiry, ownership/service checks, and atomic single-use consumption remain intact. Middleware placement is after authentication/role and existing rate-limit policies, but before relevant step-up and protected service execution.

## Tests

- `tests/unit/validate.middleware.test.js`: valid body/query/params parsing, query defaults and normalization, raw-section preservation, malformed section handling, generic error shape, and invalid middleware construction.
- `tests/integration/step-up-validation-order.test.js`: invalid requests do not consume step-up grants; valid requests consume once and replay is denied for the four sensitive routes.
- `tests/integration/marketplace-admin-listing.test.js`: seller query validation retains HTTP error compatibility.
- Existing `tests/unit/step-up.middleware.test.js`: replay and concurrent single-winner conditional-consumption mock coverage.

Verification:

- Focused: `node --test tests/unit/validate.middleware.test.js tests/integration/step-up-validation-order.test.js tests/integration/marketplace-admin-listing.test.js tests/integration/mfa-recovery-governance.test.js tests/integration/ai-dispute.test.js tests/integration/dispute.test.js tests/unit/step-up.middleware.test.js` — **31 passed, 0 failed**.
- Full: `npm.cmd test` — **414 passed, 0 failed, 11 skipped** (425 runner tests, including nested tests).
- HTTP tests ran with loopback permission. No database, provider, schema, migration, or dependency changes occurred.

## Remaining gaps and limits

Adoption is intentionally selective. Other routes retain controller-local validation, including some paths where ownership middleware executes before controller UUID parsing; those should be migrated individually with ordering tests. The `headers` section is not implemented because this task scoped the middleware to body/query/params. Concurrent step-up behavior remains tested with mocks, not a PostgreSQL concurrency run. The middleware does not replace authorization, ownership, business-state checks, or service-layer validation.
