# KYC Integration Design — Assessment

**Status: READ-ONLY design. No general KYC requirement, provider, or collection policy is approved. No KYC code/schema/API exists.**

## 1. Existing implementation

- `User` contains email, password hash, role/status and auth version. `Profile` contains display name, preferences and notification preferences. Neither includes KYC fields.
- `prisma/schema.prisma` has no KYC case, identity, document, verification state, provider reference or consent/retention model. `UserStatus` is account status (`ACTIVE`, `SUSPENDED`, `DEACTIVATED`), not KYC status.
- There is no KYC route/controller/service/provider or KYC test suite.
- A separate account-recovery workflow exists: `AccountRecoveryRequest` stores `identityVerifiedAt` and an opaque `identityVerificationRef`; `AccountRecoveryStatus` and `RecoveryApproval` govern recovery, including separate administrator approvals. `mfa-persistence.service.js` invokes an injected `verifyIndependentIdentity({ requestId, evidenceReference })` callback and fails closed when it is unavailable/false. This is recovery-specific evidence, not general identity/KYC verification. No identity document is stored by that flow.
- `Evidence` stores private object-key metadata for dispute and transaction-delivery evidence. `evidence-storage.service.js` defaults to an unavailable adapter; dispute/delivery access is bound to their domain permissions. It is not a KYC store and must not be reused without separate data classification, access, retention and provider controls.
- No app route currently accepts identity-document uploads for KYC. The existing storage abstraction is provider-neutral, but production storage is not configured.

Relevant source: `prisma/schema.prisma` (`User`, `Profile`, `AccountRecoveryRequest`, `Evidence`); `src/routes/auth.routes.js`; `src/controllers/auth.controller.js`; `src/services/mfa.service.js`; `src/services/mfa-persistence.service.js`; `src/services/evidence-storage.service.js`; `src/services/dispute.service.js`; `src/services/transaction-delivery.service.js`.

## 2. Requirement and scope assessment

The backend roadmap identifies KYC integration as missing and says product scope, privacy/retention and an identity provider must be decided. That does not establish that every TrustBridge user must pass KYC. Independent identity verification is required by the existing account-recovery/legacy-ADMIN controls, but it must not be conflated with onboarding, transaction eligibility, payment-provider KYC, or a general user KYC mandate.

**Conclusion:** general KYC collection is not currently an approved functional requirement. Before implementation, product/legal/compliance must state which user cohorts and operations require verification, legal basis, acceptable evidence, geographic scope, review/appeal policy and retention. Do not block ordinary account/profile use or transactions on an invented KYC rule.

## 3. Proposed workflow and normalized states (not implemented)

Proposed internal states, subject to policy approval:

`NOT_STARTED` → `PENDING` → `UNDER_REVIEW` → (`ACTION_REQUIRED` → `PENDING`) or terminal `VERIFIED` / `REJECTED` / `EXPIRED` / `WITHDRAWN`.

- A user starts a verification case only for an explicitly defined eligibility purpose and receives a safe opaque case ID.
- Provider session/document submission occurs only through an approved adapter and private provider/storage boundary. The client cannot set status or submit a trusted verification result.
- Verified webhook/API/manual evidence is normalized, bound to case/user/purpose, deduplicated and persisted with provenance.
- Review can request more evidence, approve, or reject with a reason code. Resubmission creates a version/history record; terminal outcomes are not overwritten.
- Expiry closes the current attempt; retry policy is bounded and audited. User/account deactivation blocks new verification and invalidates outstanding actions as defined by policy.
- KYC status never changes `User.role`, `User.status`, MFA assurance, transaction ownership, payment/escrow state, or dispute outcomes by itself. Any operation eligibility gate must separately query current persisted verification for the required purpose and validity window.

No exact state vocabulary, transitions or expiry durations should be committed to Prisma until policy and provider mapping are approved.

## 4. Proposed API contracts (not implemented)

Candidate contracts, subject to approved scope:

- `POST /api/v1/kyc/cases` — authenticated active user; purpose-specific initiation; idempotency; no role/status claims from client.
- `GET /api/v1/kyc/cases/:caseId` — owner-only safe status and next action; never provider payload or evidence key.
- `POST /api/v1/kyc/cases/:caseId/evidence` — only if app-mediated upload is approved; bounded raw upload, file/content validation, private storage, owner/case binding, audit and malware scanning boundary.
- `POST /api/v1/admin/kyc/cases/:caseId/review` — explicit reviewer role, recent TOTP step-up, reason code, separation-of-duties and audit. A list/review queue requires separate admin data minimization and rate limits.
- Provider webhook endpoint — raw-body signature verification, event dedupe, case binding and sanitized acknowledgment; no client-facing ability to assert verification.

Responses reveal only case ID, normalized state, required action, timestamps and safe reason codes. Never return identity document contents, provider raw payloads, internal risk scores or storage URLs.

## 5. Provider-neutral adapter boundary

A future injected adapter may expose:

- `createVerification({ caseId, subjectReference, purpose, returnContext })` → opaque provider reference and approved next-step instructions.
- `verifyWebhook({ rawBody, headers })` → signature/authenticity result.
- `normalizeEvent({ rawBody, headers })` → event ID, provider reference, normalized status/evidence provenance, occurred-at and safe reason code.
- `fetchVerification({ providerReference })` → authoritative current outcome for reconciliation.
- Optional `requestAdditionalEvidence(...)` only if supported by selected provider and policy.

The adapter contract must state provider/account scope, signature and replay model, event identity, status/finality meaning, supported jurisdictions, data residency, retention/deletion, retry and reconciliation. Unsupported or ambiguous results stay pending/review-required. No specific provider capability is assumed or selected.

## 6. Manual review alternative

Manual verification is **technically possible but not currently approved or implemented**. It can be a safe alternative only with a written SOP and independent human verification source, trained and authorized reviewers, least-privilege access, separation of duties (at least two reviewers for high-risk account recovery/admin enrollment), immutable audit events, evidence minimization, secure out-of-band evidence handling, strict retention/deletion and appeal/recheck procedures.

Current dispute/delivery object storage cannot be assumed suitable for identity records, and its default adapter is unavailable. Do not ask users to email identity documents to an unapproved mailbox or store them in ordinary profile/evidence fields. A reviewer must record an opaque verification reference and result only if that reference points to an approved controlled record; never claim verification occurred without actual evidence and named authorized review.

## 7. Security and privacy requirements

- Define legal basis, purpose limitation, jurisdiction, data controller/processor roles, notice/consent where required, user rights, retention/deletion and breach response before collecting documents.
- Collect the minimum attributes needed; prefer provider-issued claims/results over retaining document images. Do not retain raw documents unless approved and necessary.
- If documents are stored, use private encrypted storage, KMS-backed encryption, short-lived access, strict reviewer authorization, content validation/malware scanning, access audit and tested deletion/retention. Production storage and KMS are currently provider-gated.
- Store opaque references, status, provenance, version, timestamps and reason codes in PostgreSQL; never put identity documents or full provider payloads in DB JSON, application logs, notifications, AI prompts, blockchain or audit metadata.
- Encrypt sensitive identifiers where needed; avoid searchable plaintext identity numbers. Never log document bytes, credentials, full addresses, identity numbers or biometrics.
- Require account ownership and current account/auth-version checks. Admin review requires explicit RBAC, recent TOTP, safe rate limits and independent audit. Admin status does not grant access to unrelated evidence.
- Fail closed for operations that explicitly require current verification when provider/storage/reconciliation is unavailable; unrelated flows remain unaffected unless policy says otherwise.

## 8. Proposed schema direction and migration

Only after approved scope: add a KYC case/version model with user FK, purpose, normalized status, version, timestamps, expiry, reviewer IDs/reason codes and unique provider/account/reference; append-only decision/history rows; optional evidence metadata rows with opaque private object key, MIME, size/hash, uploader, retention/deletion state and restrictive FKs. Add constraints for legal state transitions where feasible, duplicate provider events, single active case policy if approved, reviewer separation and ownership. Keep account status and KYC state distinct.

Migration must be additive, preserve all existing users/profiles/recovery/evidence records, and avoid backfilling users as verified/unverified without evidence. No migration is currently required or created.

## 9. Decisions and recommended sequence

Required approvals: (1) whether KYC is required at all and for which purposes/cohorts; (2) legal basis, jurisdiction and privacy/retention rules; (3) provider versus controlled manual review; (4) evidence types and whether document images must be retained; (5) reviewer roles, dual-control threshold, appeal and expiry; (6) exact operation gates; (7) provider eligibility, data residency, webhook/finality and deletion capabilities.

Sequence: approve policy and data map → select provider/manual governance and storage/KMS controls → finalize states and threat model → additive schema contract and migration review → provider-neutral service/adapter and manual-review boundary → authenticated user/admin APIs and operation-specific gates → unit/HTTP/isolated PostgreSQL tests for authorization, replay, concurrency, retention and redaction → provider staging/manual operational exercise → update the functional audit only with verified evidence.

**Recommendation:** KYC integration is **BLOCKED pending scope and compliance decisions**. The immediate next task is a product/legal decision record, not implementation.
