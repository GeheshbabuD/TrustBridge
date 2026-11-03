# API Documentation Plan

Base `/api/v1`; registration and credential-verification login are implemented. Other listed endpoints remain planned. Generate OpenAPI and Postman after contracts stabilize.

Success envelope: { success: true, message: "Operation successful", data: {} }. Error: { success: false, message: "Operation failed", error: { code: "VALIDATION_ERROR" } }. Use safe messages, stable codes, correct HTTP status and pagination; never expose secrets, hashes or prompts.

| Endpoint | Purpose | Authentication/policy |
|---|---|---|
| POST /auth/register | Create account from `email`, `password`, optional `displayName`; returns 201 with `data.user` containing only `id`, normalized `email`, `createdAt`, and profile display name. Invalid/extra fields: 400; duplicate conflict: generic 409. | Public, Zod validation, API rate limit, bcrypt hash, atomic User/Profile transaction; role/status are never client-controlled |
| POST /auth/login | Verify `email` and `password`; a USER without active MFA receives 200 with safe `user`, short-lived `accessToken`, opaque `refreshToken`, and `tokenType`. An active-MFA account receives 202 with `mfaRequired`, opaque `challengeToken` and expiry only; ADMIN without active MFA receives the generic 401. Unknown email, incorrect password, and inactive account share the same 401. | Public, strict Zod validation, dedicated IP limiter; active MFA is based on persisted state |
| POST /auth/mfa/challenge/verify | Accept `{ challengeToken, code }`; successful verification returns 200 with access and refresh tokens; all invalid/expired/consumed/exhausted challenges return generic 401. Extra account identifiers are rejected. | Public challenge flow, dedicated IP limiter plus five durable challenge attempts, five-minute challenge |
| POST /auth/refresh | Accept `{ refreshToken }`, atomically revoke the presented token and issue a replacement in the same family. Returns new access and refresh tokens. Unknown, expired, revoked and replayed tokens share a generic 401. | Public, rate-limited; hashed lookup, unique successor lineage, family revocation on reuse |
| POST /auth/logout | Accept `{ refreshToken }`, idempotently revoke that token; unknown token also returns success. | Public, rate-limited. MFA-assured JWT requests verify the persisted session and are denied after revocation; password-only USER access JWTs remain valid until expiry |
| GET/PATCH /users/me | Profile | Authenticated owner, field allowlist |
| POST/GET /transactions; GET /transactions/:id | Create/list/read | Authenticated participants, object ownership |
| POST /transactions/:id/accept, /cancel, /delivery, /confirm | Lifecycle actions | Invited seller/party rules; state machine decides validity |
| POST /payments/orders; GET /payments/:id | Create/read payment attempt | Participant; an order is not escrow funding |
| POST /payments/webhooks/:provider | Provider callback | Raw-body signature verification, durable inbox and replay protection; capture confirmation is separate from escrow ledger posting |
| POST /escrow/:id/release-authorizations; POST /escrow/:id/refund-authorizations | Record policy authorization | Buyer-confirmation/admin-resolution rules; does not itself issue payout/refund |
| Internal provider adapter/worker for payout/refund | Execute authorized provider operation | Idempotency and verified provider outcome; only then update terminal transaction state |
| Internal reconciliation worker / GET admin reconciliation cases | Compare provider, webhook, escrow journal and transaction state | Admin review for mismatch; no silent ledger corrections |
| POST /disputes; GET /disputes/:id; POST /disputes/:id/evidence | Dispute/evidence | Participant ownership and upload limits |
| POST /admin/disputes/:id/resolve | Resolve | Admin, reason and audit |
| GET /notifications; POST /notifications/:id/read | Own notifications | Authenticated owner |
| GET /admin/audit-logs; /admin/transactions | Monitoring | Admin, filters and pagination |
| POST /ai/transactions/:id/assess; /ai/disputes/:id/analyze | Advisory only | Authorized user/admin; validated output |
| GET /blockchain/transactions/:id/verify | Verify reference | Participant/admin, pending/inconsistent states explicit |

Contracts are provisional; confirm frontend and policy needs. Never accept arbitrary status assignment. Enforce auth, role and ownership, validation, limits, redaction, idempotency and signatures.

Authorization middleware exports `requireAuthentication`, `requireRole`/`requireRoles`, `requireTransactionParticipant`, `requireOwnUser`, `requireOwnNotification`, `requireDisputeParticipant`, `requireEvidenceParticipant`, `requirePaymentAttemptParticipant`, and `requireEscrowParticipant`. Mount authentication first. Participant checks use only `request.auth.userId`, actual participant rows and transaction buyer/seller IDs. Resource checks return the same not-found response for missing and unauthorized IDs. No transaction, dispute, evidence or administrative endpoints are implemented or mounted by TB-BE-033.

Access JWTs contain standard issuer/audience/expiry claims, `av` (authorization version) and `sid` (refresh-session row ID); only sessions verified with MFA also contain server-signed `mfa_at` (Unix seconds). Bearer middleware checks current user status, role and authorization version. For MFA-assured requests it also checks the persisted session's user/version/MFA timestamp and revocation state. Refresh tokens are 32 random bytes encoded base64url and persisted only as a SHA-256 hash. Rotation is atomic; replay revokes its active family. Revocation is checked for MFA-assured access requests; password-only USER JWTs remain stateless and valid until expiry. PostgreSQL transaction concurrency still requires a designated disposable integration database.

## TOTP enrollment API (TB-BE-034C)

All three endpoints require an active authenticated Bearer account. Roles and status are loaded from the database. The enrollment endpoints do not change access-token assurance and do not protect login or privileged actions; those remain TB-BE-034D.

`POST /api/v1/auth/mfa/enroll` accepts `{}` and returns 201 with `data.enrollmentId`, `expiresAt`, `secret`, and `provisioningUri`. The Base32 secret and `otpauth://` URI are shown once to provision an authenticator; handle them as credentials. The pending secret is encrypted at rest. An existing active enrollment or unexpired pending enrollment returns a safe 409 and is never silently replaced. Expired pending enrollment may be restarted.

`POST /api/v1/auth/mfa/verify` accepts `{ "code": "123456" }`. A valid current or configured-skew-window code returns 200 with `{ "enabled": true, "recoveryCodes": [...] }`. This is the only response that displays this generated recovery-code batch; raw codes cannot be retrieved later. Incorrect/expired/replayed codes return a generic 400. Verification attempts are limited to five failures per authenticated user per ten minutes (configurable); the current rate-limit store is process-local.

`GET /api/v1/auth/mfa/status` returns only `{ enabled, enrollmentPending, requiredByPolicy, unusedRecoveryCodes }`. `requiredByPolicy` reflects the current persisted ADMIN role, but enrollment status alone does not grant assurance. No disable endpoint, recovery-code login or administrator recovery endpoint is implemented. Production enrollment remains unavailable until a production KMS provider is configured.

### Login challenge and recent assurance (TB-BE-034D)

`POST /api/v1/auth/login` verifies password first and reads role/MFA from PostgreSQL. Password-only USER without active MFA receives the normal session response. Active-MFA USER and ADMIN with enabled MFA receive `202 Accepted` with `data: { mfaRequired: true, challengeToken, expiresAt }`; no user details, access token or refresh token are returned in this stage. ADMIN without enabled MFA receives the generic `401 INVALID_CREDENTIALS` response.

`POST /api/v1/auth/mfa/challenge/verify` accepts only `{ "challengeToken": "<opaque>", "code": "123456" }`. It returns `200` and the standard access/refresh token response on success. The five-minute default challenge expires after five minutes, is purpose-bound to LOGIN and allows five failed codes. Invalid, expired, consumed, revoked-by-consumption, stale-authVersion, exhausted and wrong-purpose challenges share a generic `401 INVALID_MFA_CHALLENGE`. There is no account ID field. Password login is limited to 10 requests per IP per 15 minutes and challenge verification to 5 per IP per 10 minutes by default; both limits are configurable and process-local.

JWT `mfa_at` is a backend-signed Unix-seconds timestamp for the second factor that completed this session; `sid` binds it to the persisted refresh-token row and `av` is the account authorization version. It proves that TOTP completed at issuance, not that MFA was verified recently forever or that the client device is trusted. MFA-authenticated requests check current user state/version and the linked session's MFA timestamp/revocation. Password-only USER tokens remain valid until their expiry after logout; MFA-assured requests fail after linked-session revocation. Refresh preserves stored assurance and never upgrades it. `requireRecentMfa` checks login assurance freshness; sensitive operations must use the purpose-specific persisted step-up middleware described below.

## Purpose-bound step-up (TB-BE-034E)

`POST /api/v1/auth/mfa/step-up/challenge` requires an active authenticated MFA session and accepts a strict body such as `{ "purpose": "MFA_RECOVERY_CODES_REGENERATE", "resourceId": "<current-user-uuid>" }`. It returns 201 with an opaque challenge token, expiry and safe purpose/resource metadata. The default lifetime is five minutes (`MFA_STEP_UP_CHALLENGE_TTL_SECONDS`, bounded to 60–600 seconds). Only the server registry in `src/services/step-up-purpose.registry.js` may permit a purpose. The current registry contains only `MFA_RECOVERY_CODES_REGENERATE`, restricted to the authenticated user's own USER resource; that recovery-code endpoint is not implemented. Future modules must explicitly register operation-specific purposes with resource type/requirement, allowed roles, maximum age and additional-authorization policy.

`POST /api/v1/auth/mfa/step-up/verify` requires the same authenticated session and accepts only `{ "challengeToken": "<opaque>", "code": "123456" }`. The persisted challenge supplies user/session/purpose/resource, so client account, session, purpose and resource fields are rejected. Success returns purpose/resource and server verification time, without access/refresh tokens or a new session. Invalid, expired, consumed, mismatched, revoked, stale-version, inactive-MFA and exhausted challenges return a safe generic error. Both endpoints use dedicated configurable IP limits (five per ten minutes by default, in-memory/single-instance) plus a durable per-challenge five-attempt cap.

Future sensitive routes must compose authentication, role and resource ownership/participant checks, then `createStepUpAuthorizationMiddleware({ purpose, resourceId: request => request.params.<resource> })`. It checks a consumed recent challenge grant bound to the same user, live refresh session, auth version, purpose, resource and unchanged MFA enrollment. MFA proves only a recent second factor; it does not establish ownership, payment authorization, consent or authority to release funds or decide disputes. No sensitive business route currently uses this middleware.

Operational note: an existing ADMIN without active MFA receives only generic credential failure and cannot use authenticated enrollment because no normal session is issued. Do not promote or provision an ADMIN through the ordinary flow without completing MFA setup first. Controlled bootstrap for legacy ADMIN accounts remains deferred to TB-BE-034G; no bypass token is provided here.
