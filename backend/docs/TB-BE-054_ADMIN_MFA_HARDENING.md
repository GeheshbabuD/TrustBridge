# TB-BE-054 — Legacy ADMIN MFA Step-Up Hardening

**Status:** Implemented and verified. No schema, migration, dependency, provider, or database changes.

## Change

`src/routes/auth.routes.js` now places the existing `createRecentMfaMiddleware({ maxAgeSeconds: 300 })` gate on both:

- `GET /api/v1/auth/mfa/admin-enrollment/legacy-admins`
- `POST /api/v1/auth/mfa/admin-enrollment/requests`

The order is authentication, ADMIN role authorization, recent-TOTP check, recovery mutation rate limiter, and controller. The five-minute maximum matches the established ADMIN recent-MFA convention already used by `/admin/users` and admin transaction/dispute listing routes. No new purpose, assurance duration, or client-selected resource policy was introduced.

The gate accepts only `request.auth.assuranceLevel === "TOTP_VERIFIED"`, active MFA and a recent valid server-created `mfaVerifiedAt`. In production this request context is constructed by `src/middleware/auth.middleware.js` from a verified JWT matched against the persisted active user/session and current MFA enrollment. Client body/query claims do not populate or elevate it. Existing identity verification, two-distinct-admin approvals, purpose-bound step-up for identity/approval/authorization issuance, and enrollment verification remain unchanged.

## Focused regression coverage

`tests/integration/mfa-recovery-governance.test.js` verifies both routes with recent TOTP, and verifies denial for missing authentication, absent assurance, expired assurance, recovery-code assurance, and non-ADMIN role. It also verifies denied requests never invoke the protected service methods. The integration fixture supplies a server-side authentication context; claim/session derivation remains covered by `tests/unit/auth-middleware.test.js`.

## Verification

- Initial sandboxed focused command: `node --test tests/integration/mfa-recovery-governance.test.js tests/unit/recent-mfa.middleware.test.js tests/unit/auth-middleware.test.js tests/unit/authorization-middleware.test.js` — 20 passed, 2 failed at HTTP `fetch()` before route assertions because loopback networking was unavailable in that execution. No application defect was inferred from those failures.
- Same focused command rerun with loopback permission — **22 passed, 0 failed, 0 skipped**.
- `npm.cmd test` with loopback permission — **401 passed, 0 failed, 11 skipped** (412 total tests).
- No database or provider operations were performed.

The ordinary account-recovery HTTP workflow remains outside this task and unresolved as noted in the TB-BE-053 audit.
