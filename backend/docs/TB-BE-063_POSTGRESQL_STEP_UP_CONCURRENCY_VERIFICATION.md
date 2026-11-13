# TB-BE-063 — PostgreSQL Step-up Grant Concurrency Verification

**Status:** Verified against the isolated PostgreSQL test target. No application, schema, migration, dependency, or database setup changes were made.

## Implementation reviewed

`src/middleware/recentMfa.middleware.js` consumes a one-time grant in a Prisma interactive transaction. It locks the authenticated user's `user_mfa` row with parameterized `SELECT ... FOR UPDATE`, checks the enabled enrollment timestamp, selects one verified eligible challenge with `grantConsumedAt: null`, and conditionally updates only that challenge ID. Success requires exactly one updated row. The update writes only `grantConsumedAt`; `consumedAt` remains the successful challenge-verification marker. User status/authVersion, session ownership/status/expiry/MFA assurance, purpose, resource and verification recency remain in the selection/update predicates. Failures deny or fail closed.

## PostgreSQL isolation evidence

The existing harness in `tests/postgres/assurance-concurrency.integration.test.js` is opt-in via `TRUSTBRIDGE_PG_TESTS=1`. Before connecting it asserts that the configured source URL is local `localhost:5432/Trustbridge`, rewrites the database path to `trustbridge_test`, then queries the live identity and asserts database `trustbridge_test`, PostgreSQL 17.10, port 5432 and a loopback server address. It also verifies the two Prisma clients have distinct PostgreSQL backend PIDs. No development or production database was connected.

Test data uses generated UUIDs tracked by the current run; cleanup deletes only child rows and users for those IDs. Injected failure triggers use random test-only names and are dropped in `finally`. No global cleanup, truncation or reset is used.

## Results

Command:

```text
$env:TRUSTBRIDGE_PG_TESTS = '1'
node --experimental-strip-types --test tests/postgres/assurance-concurrency.integration.test.js
```

- PostgreSQL integration runner: **14 passed, 0 failed, 0 skipped** (one suite wrapper plus 13 scenario subtests).
- Concurrent grant consumption with independent clients: **exactly one success, one denial**.
- Subsequent replay: denied; `grantConsumedAt` remained at the first winner's timestamp.
- Verification marker: `consumedAt` remained equal to its pre-consumption value.
- Expired/stale verification, wrong-purpose and wrong-resource grants: denied; all three retained `grantConsumedAt = null`.
- Existing MFA challenge/recovery/session concurrency and transaction rollback scenarios in the same suite also passed.
- Existing malformed-request/no-consumption and route ordering tests: `node --test tests/integration/step-up-validation-order.test.js tests/integration/dispute.test.js tests/unit/recent-mfa.middleware.test.js tests/unit/step-up.middleware.test.js` — **24 passed, 0 failed**. No duplicated HTTP coverage was added.
- Full suite was not rerun: application code was unchanged and the task requested focused PostgreSQL verification.

A sandboxed connection attempt returned `EACCES` before database identity verification. The identical guarded test was rerun with local connection access; the in-test identity assertions passed. Node v22.14.0 required `--experimental-strip-types` for the checked-in generated Prisma TypeScript client.

## Limitations

This verifies the tested PostgreSQL 17.10 local isolated database and the exercised middleware paths only. It does not certify production infrastructure or other PostgreSQL versions. The existing pg test helper emitted a non-fatal deprecation warning while issuing concurrent `client.query()` calls; no test failed and this task did not change test infrastructure beyond the grant assertions.
