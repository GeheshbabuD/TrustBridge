# TB-BE-059 — Remaining Step-up Authorization Ordering Hardening

**Status: IMPLEMENTED; focused and full test suites passed.**

## Changes

Added route-local preflight checks, using the existing schemas, ahead of single-use step-up on:

- `POST /api/v1/auth/mfa/recovery-codes/regenerate`
- `POST /api/v1/auth/mfa/disable`
- `GET /api/v1/admin/disputes/:disputeId`
- `POST /api/v1/admin/disputes/:disputeId/assistance`

The auth endpoints validate the existing strict empty-body schema. Dispute detail validates its UUID before step-up. AI dispute assistance validates its UUID and existing strict empty-body contract before step-up. Authentication, rate limiting, role checks, controller validation, persisted purpose/resource binding, TOTP and expiry rules, and atomic grant consumption are unchanged. Invalid requests return the existing generic `400 VALIDATION_ERROR`; invalid inputs do not reach the protected service or consume a grant.

No shared validation middleware was introduced. No database, schema, migration, dependency, or provider operations occurred.

## Verification

- Focused: `node --test tests/integration/step-up-validation-order.test.js tests/integration/mfa-recovery-governance.test.js tests/integration/ai-dispute.test.js tests/integration/dispute.test.js tests/unit/step-up.middleware.test.js` — **24 passed, 0 failed**.
- Full: `npm.cmd test` — **408 passed, 0 failed, 11 skipped** (419 tests reported by Node's runner, including nested tests).
- HTTP tests were run with loopback networking enabled. The initial sandbox-only focused attempt failed at `fetch` before route assertions; the permitted rerun passed.
- Valid calls and replay are covered by in-memory single-use route fakes; middleware replay/concurrent single-winner behavior is covered by unit mocks. PostgreSQL concurrency was not run and is not claimed.

## Remaining risk

TB-BE-058's separate LOW shared-validation consistency gap remains: validation is distributed across routes/controllers and `src/middleware/validate.middleware.js` is empty and unused. Other routes with reusable recent-MFA or ownership middleware preceding controller parsing were outside this task's four-route scope. A later scoped audit can prioritize them without broad adoption or refactoring.
