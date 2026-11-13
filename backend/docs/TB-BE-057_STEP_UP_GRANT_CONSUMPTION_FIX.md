# TB-BE-057 — Step-up Grant Consumption Ordering Fix

**Status: IMPLEMENTED; focused and full test suites passed.**

## Correction

Affected ADMIN dispute review/resolution and legacy ADMIN enrollment authorization, identity-verification, and approval routes now validate their relevant path parameters and request bodies before invoking one-time step-up authorization. Controllers retain their existing validation as a second boundary. Authentication, ADMIN role checks, purpose/resource binding, TOTP assurance, expiry, and the existing transactional conditional `grantConsumedAt` update are unchanged.

Malformed input therefore returns the sanitized validation error without consuming a grant or invoking the protected service. A valid request still consumes the purpose-bound grant once; a replay is denied. The step-up middleware's database transaction and conditional update were not modified.

## Verification

- Focused: `node --test tests/integration/step-up-validation-order.test.js tests/integration/dispute.test.js tests/unit/step-up.middleware.test.js` — **16 passed, 0 failed**. HTTP tests required loopback permission and were rerun with that permission; the initial sandbox run failed at `fetch` before route assertions.
- Full: `npm.cmd test` — **405 passed, 0 failed, 11 skipped** (416 tests reported by Node's runner, including nested tests).
- The focused concurrency regression uses a transactional mock. PostgreSQL concurrency was not run for this task; the test is not evidence of database-level locking.
- No schema, migration, dependency, database, or provider changes.

## Remaining input-validation follow-up

The separate TB-BE-056 LOW consistency gap remains: `src/middleware/validate.middleware.js` is an empty unused placeholder, while validation is mostly controller-local. This task deliberately did not refactor it or unrelated routes.
