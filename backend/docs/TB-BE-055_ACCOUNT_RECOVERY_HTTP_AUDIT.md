# TB-BE-055 — Account Recovery HTTP Workflow Readiness Audit

**Assessment only.** No application, test, schema, migration, database, provider, or recovery-document changes were made. This review follows the recovery service/persistence, auth controller/routes/validators, purpose registry, and focused MFA/recovery tests.

## 1. Verified service-level operations

`src/services/mfa.service.js` exposes ordinary recovery methods: `createAccountRecoveryRequest`, `verifyAccountRecoveryIdentity`, `approveAccountRecovery`, and `completeAccountRecovery`. These delegate to `src/services/mfa-persistence.service.js`.

- **Request creation:** accepts an internal `userId`, optional `requestedByUserId`, and caller-provided expiry. It locks the subject user, requires an active user, expires old pending requests, returns an existing pending request if present, or creates/audits a request. The legacy-admin variant additionally requires an active ADMIN target without enabled MFA. Its service wrapper sets a 30-minute expiry.
- **Identity verification:** calls the injected `verifyIndependentIdentity` callback; absent, failing, or negative callback results fail closed. On positive result, a serializable transaction conditionally records verification only for a pending, unexpired request whose subject remains active. A repeated or raced verification cannot update the request twice. Identity verification itself has no HTTP route for ordinary account recovery.
- **Approval:** locks the recovery request, approver/subject and relevant MFA rows; requires the subject active, request pending, verified identity, unexpired request, and an active ADMIN approver with enabled MFA. Self-approval is rejected. The schema enforces one decision per `(requestId, approverId)`. Two distinct qualifying approvals advance the request to `APPROVED`; conditional version update and transaction serialization protect races. Legacy-admin authorization issuance/enrollment performs further checks.
- **Completion:** locks the request, users, and MFA rows; requires approved, identity-verified, unexpired request, rejects the subject completing their own recovery, revalidates two distinct active MFA-enabled ADMIN approvers and an active MFA-enabled ADMIN operator, disables/clears subject MFA, invalidates unused recovery codes, revokes all subject sessions, increments `authVersion`, and marks the request completed in one serializable transaction. Audit failure rolls the state change back.

Completion applies only to non-ADMIN subjects. Legacy ADMIN enrollment is a separate controlled workflow: two distinct active MFA-enabled ADMIN approvals, independently verified identity, ten-minute enrollment authorization stored as a challenge hash, out-of-band delivery callback that fails closed, single-use authorization claim, then successful TOTP enrollment before privileged access is restored. Recovery-code assurance remains distinct from TOTP assurance.

## 2. HTTP exposure

### Ordinary account recovery

No ordinary account-recovery request, identity-verification, approval, or completion route/controller is present in the inspected `src/routes/auth.routes.js` and `src/controllers/auth.controller.js`. The service methods are not reachable through the current HTTP API. This is an incomplete API workflow, not a demonstrated externally exploitable route.

### Legacy ADMIN MFA onboarding (separate workflow)

The following routes exist in `src/routes/auth.routes.js`:

- `POST /mfa/admin-enrollment/requests` — authentication, ADMIN role, recent server-verified TOTP (five-minute existing admin convention from TB-BE-054), shared recovery mutation limiter.
- `GET /mfa/admin-enrollment/legacy-admins` — same controls; returns active legacy ADMIN IDs/emails.
- `POST /mfa/admin-enrollment/requests/:requestId/identity` — ADMIN, shared limiter, one-time `ADMIN_RECOVERY_IDENTITY_VERIFY` purpose-bound step-up.
- `POST /mfa/admin-enrollment/requests/:requestId/approval` — ADMIN, shared limiter, one-time `ADMIN_RECOVERY_APPROVAL` step-up.
- `POST /mfa/admin-enrollment/requests/:requestId/authorize` — ADMIN, shared limiter, one-time `LEGACY_ADMIN_MFA_ENROLL_AUTHORIZE` step-up; delivery failure fails closed.
- `POST /mfa/legacy-admin-enrollment/start` and `/verify` — bearer authorization token in request body, challenge rate limiter; token is hashed in persistence, expires, and is consumed conditionally. TOTP must be verified to complete enrollment.

These are not general USER account-recovery routes. The route-level identity verification is purpose-bound; ordinary identity verification has no route on which to verify authorization.

## 3. Identity references, tokens, session revocation, and audit

- The independent identity verifier is an injected server callback. The request body only supplies `evidenceReference`; the caller cannot set `identityVerifiedAt` or assert verification success. In legacy-admin HTTP use, the callback is preceded by the registered one-time ADMIN step-up bound to the recovery request.
- The reference is validated as a non-empty string up to 255 characters and persisted in `AccountRecoveryRequest.identityVerificationRef`. The code does not enforce that it is an opaque provider reference rather than PII, document content, or a credential. Audit metadata records subject/request identifiers but omits the reference. Reference format, classification, retention, and deletion policy remain undecided.
- Ordinary recovery does not issue a recovery authorization token. Legacy ADMIN enrollment uses a random authorization token; only its hash is persisted in `MfaChallenge`, the raw token is delivered through an injected out-of-band provider, and delivery failure expires the challenge. Enrollment claims it once and is bounded by expiry and current user/authVersion/MFA/approval checks.
- Successful ordinary completion atomically invalidates sessions/recovery codes, disables MFA and advances `authVersion`; stale sessions are therefore invalidated. It does not issue a session. The post-completion login/re-enrollment UX and user notification contract are not exposed/documented through an HTTP workflow.
- Request creation, identity verification, approvals, completion, and legacy authorization/enrollment produce audit records. Focused PostgreSQL tests cover approval/completion concurrency and rollback; no ordinary recovery HTTP tests exist because no such routes exist.

## 4. Security risks and incomplete guarantees

### High — Ordinary recovery is not an end-to-end HTTP workflow

The backend has persistence/service primitives but no externally reachable entry point or completion controller. Users cannot invoke ordinary recovery through the current API. This is a completeness blocker. Do not expose the methods by simply passing a client-supplied `userId` or `evidenceReference` through a thin controller.

### Medium — Direct request creation is enumeration-prone if exposed as-is

`createAccountRecoveryRequest` accepts a target UUID, returns either the existing/new request record, and throws an account-unavailable error for missing/inactive subjects. A public endpoint that directly exposes those outcomes would permit target discovery and return request-specific information. A safe public initiation needs an approved account-identifier lookup boundary, normalized inputs, uniform response/timing policy, abuse controls, and no observable distinction between eligible and ineligible accounts. No such HTTP policy or endpoint exists yet, so current external enumeration through this method was not found.

### Medium — Recovery operator assurance is enforced by routes for legacy operations, not uniformly by ordinary service primitives

`recordRecoveryApproval` and `completeAccountRecovery` validate operator ADMIN/active/MFA enrollment at persistence, but their ordinary service signatures receive an approver/operator ID rather than a verified session or assurance context. The current legacy HTTP routes add purpose-bound TOTP; ordinary recovery has no route. If an ordinary HTTP workflow is added, it must use route step-up and preferably pass/verify the exact persisted session assurance at the service boundary before approval/completion. No client-supplied role or assurance may substitute. A purpose for ordinary recovery completion is not currently registered.

### Medium — Identity reference is not constrained to an opaque, non-sensitive reference

The callback verifies the supplied reference, but schema/validator only bound its length; persistence stores the raw value. No identity document contents are explicitly stored in this column by the intended contract, but the implementation does not prevent a caller/provider from placing sensitive material there. Define an opaque-reference contract, provider response format, retention, access, and logging rules before HTTP exposure.

### Unresolved — Enumeration, rate limits, expiry, and replay at an ordinary HTTP boundary

Persistence has expiry, unique approvals, serializable transactions and conditional updates. The legacy routes have shared mutation/challenge limiters and safe generic enrollment-token failures. The absent ordinary routes have no endpoint rate limiting, public enumeration behavior, request-status disclosure policy, or HTTP replay tests. These must be designed before exposure.

## 5. Existing test evidence

- `tests/unit/mfa-persistence.test.js`: covers external identity callback requirement, two distinct active ADMIN approvals, self-approval rejection, and failure closed when legacy enrollment delivery is absent.
- `tests/postgres/assurance-concurrency.integration.test.js`: includes recovery approval concurrency, legacy enrollment token hash/expiry/replay checks, and account-recovery completion rollback on audit failure followed by successful completion; this file uses PostgreSQL integration infrastructure. This audit did not run tests or connect to a database.
- `tests/integration/mfa-recovery-governance.test.js`: covers recovery-code regeneration and legacy-admin route hardening from TB-BE-054; it does not cover ordinary account-recovery HTTP because those routes are absent.
- Existing tests establish selected persistence and legacy route behavior; they do not establish an ordinary recovery API contract, enumeration resistance, identity-provider delivery behavior, or service-level TOTP enforcement for ordinary completion.

## 6. Smallest safe HTTP workflow (future design; not implemented)

1. **Request initiation:** expose a generic recovery request entry using a verified account-identifier lookup inside the service, not a client-selected internal UUID. Return a uniform acknowledgment for eligible/ineligible/duplicate cases; apply shared IP and privacy-safe account rate limits. Do not reveal request IDs or status to an unauthenticated requester unless an approved, secure delivery challenge binds the requester to the subject.
2. **Identity verification:** invoke only the approved independent identity provider/manual verification boundary. Client input may identify a provider case, but only the server-side verifier result changes identity state. Store an opaque reference, never evidence content; audit with minimal metadata. Provider outage fails closed.
3. **ADMIN review and approval:** ADMIN-only listing/detail and each identity/approval operation require current active session plus registered purpose-bound TOTP; retain two distinct active MFA-enabled approvers, subject self-approval denial, uniqueness, request expiry, audit, rate limiting and conditional transactional state transitions. Do not expose detailed target data to unauthorized roles.
4. **Completion:** add an explicit server-controlled purpose/resource policy for the sensitive completion operation only after Security approves it. Recheck verified identity, approvals, active target, request expiry, exact ADMIN session/TOTP assurance, then atomically reset MFA/recovery material, revoke sessions, increment authVersion, and complete/audit the request. Do not return a privileged session or treat recovery-code assurance as TOTP.
5. **Post-recovery:** define a safe user notification and sign-in/re-enrollment path. Use only an approved secure delivery provider; do not reveal whether an account exists or include recovery secrets. Reuse current login/MFA enrollment controls and ensure any new session has only the assurance supported by its authentication method.

This is a boundary-level sequence, not a final API contract. Exact endpoints, identifier normalization, requester authentication, notification/delivery channel, approval view fields, completion purpose/freshness/resource binding, and provider outage responses require approval.

## 7. Prioritized tasks and approvals

1. **Product + Security:** decide whether ordinary recovery should be exposed, how requester identity/account lookup works, and the non-enumerating response and status-disclosure contract.
2. **Legal/Compliance + Security + Operations:** approve independent identity verification method/manual alternative, opaque reference format, data retention/access, secure user notification/delivery, and provider outage/escalation behavior. No provider capability is assumed here.
3. **Security:** approve purpose-bound TOTP policy for ADMIN review/approval/completion, including completion purpose, one-time policy, resource binding and freshness; preserve recovery assurance as non-TOTP.
4. **Engineering:** add the smallest controller/validator/routes/service facade only after decisions; include shared fail-closed rate limits, audit and uniform errors. Reuse existing persistence transactions and legacy governance controls; do not duplicate models.
5. **Testing:** add HTTP tests for unauthenticated and non-admin denial, generic enumeration responses, invalid identity references/provider outage, expired/replayed request/token, duplicate/self approvals, recovery-code assurance denial, TOTP step-up and no partial effects; retain isolated PostgreSQL concurrency/rollback tests for approval and completion.

**Readiness conclusion:** Persistence governance primitives exist and selected dual-approval, expiry, revocation, and atomicity protections are tested. The ordinary account-recovery HTTP workflow is **NOT READY**: it is absent, the identity/account lookup and delivery policies are not approved, and direct exposure of current UUID-based service inputs would be unsafe. Legacy ADMIN MFA onboarding remains a separate routed flow, with its initiation routes hardened by TB-BE-054.
