# TB-BE-068 — Controlled Staging Deployment Readiness

**Assessment date:** 2026-11-13  
**Decision:** **NO-GO for staging deployment at present.** The implementation has a portable startup contract and tested lifecycle behavior, but no staging platform, staging services, deployment artifact, migration target, or provider setup has been selected and verified. This is an assessment, not a deployment record.

## Evidence and status terms

- **Implemented** means the behavior exists in the inspected source.
- **Tested** means the cited project record describes tests; it does not imply a live staging deployment.
- **Documented** means deployment guidance exists.
- **Unverified** means no current staging/provider/host evidence was inspected or executed. No tests or external checks were run for this assessment.

## Readiness findings

| Area | Current evidence | Assessment |
|---|---|---|
| Runtime | `package.json` declares Node `^24.0.0 || ^26.0.0`; `npm start` runs `node --experimental-strip-types src/server.js`. The local command environment reported Node `v22.14.0` and npm `11.6.2`; this Node is outside the declared engine. `docs/DEPLOYMENT_GUIDE.md` records earlier focused/full verification on Node 24.22.1, but not a hosted artifact. | **Implemented / partially tested.** Before staging, use a supported 24/26 runtime, verify the generated Prisma runtime and exact artifact. Node 26 was not verified. |
| Configuration and composition | `src/config/env.js` validates configuration; production requires `NODE_ENV`, `DATABASE_URL`, JWT access/refresh secrets, Redis rate-limit configuration and a distinct key secret, KMS provider/key metadata, and `TRUSTBRIDGE_COMPOSITION_MODULE`. `src/config/application-composition.js` loads `createApplicationDependencies({ environment })`, requires a matching `kms-envelope` adapter, and validates any supplied shared rate limiter. Missing production composition/KMS fails closed. | **Implemented; provider integration unverified.** Secret names only are listed; no values were inspected. There is no real production KMS adapter or approved staging KMS configuration in evidence. |
| Startup commands | `package.json` exposes `start`, `dev`, `test`, `test:watch`, and `prisma:generate`; no build command or standalone worker command is defined. `src/server.js` validates/composes dependencies before starting HTTP. It does not run migrations at startup. | **Implemented, artifact unverified.** `npm start` is the runtime command. API and workers share a process. A production-only runtime should not be assumed to contain Prisma CLI (`devDependency`). |
| Database migration | `prisma.config.ts` points Prisma at the canonical schema/migration directory and validated database URL. There are 16 migration directories; two share timestamp prefix `20261104130000` and have different names (`escrow_ledger_operations`, `transaction_terms_invitations`). Directory naming gives a deterministic lexical order, but the actual staging migration history and effects have not been checked. Deployment docs prescribe a separate serialized migration job from the reviewed commit/lockfile, target preflight, restorable backup, and `prisma migrate deploy`; no app-startup migration. | **Documented; staging execution unverified.** The shared timestamp prefix needs explicit review in the release manifest and dependency-order review; never infer migration status from directory presence. No staging database identity, pending set, migration run, or rollback rehearsal exists in evidence. |
| Startup/shutdown | `src/server.js` starts workers when the HTTP listener is listening. Shutdown is idempotent: stop accepting connections, drain requests/workers within `SHUTDOWN_DRAIN_TIMEOUT_MS` (1,000–300,000 ms; default 30,000), then close Prisma/Redis. If worker completion is uncertain at timeout, it reports failure and leaves DB/Redis open; jobs remain subject to lease recovery. | **Implemented and unit/HTTP tested.** Deployment supervisor termination grace must exceed the configured drain window and allow failure handling. Orchestrating separate API/worker roles is not supported by a standalone command. |
| Health/readiness | `src/app.js`: `/health` and `/health/live` indicate process liveness; `/health/ready` probes DB and rate-limit store and, in production, MFA encryption. Production also requires shared rate limiting. A configured required worker must be `running`; currently an enabled escrow worker is required, while notification and blockchain workers are optional. Responses sanitize worker status/errors. | **Implemented and tested with fakes.** Readiness does not establish backup, evidence-storage, email, payment-provider, queue-age, or external monitoring health. |
| Outbox and worker failure | Escrow lease claims are conditional with a 60-second lease. Invalid bindings are retained as terminal `FAILED` records with a generic code and are not auto-replayed; transient failures return to `PENDING` after 60 seconds without a retry ceiling. See `docs/TB-BE-066_OUTBOX_POISON_EVENT_HANDLING.md`. | **Implemented; DB deployment behavior unverified.** Failed rows have no approved operator review/replay/retention process; transient retries can continue indefinitely. |
| Metrics and alerts | `src/services/operational-metrics.adapter.js` provides bounded, low-cardinality process-local metrics; injected sink is optional. `docs/TB-BE-067_WORKER_OUTBOX_METRICS.md` records metrics tests using mocks. Worker alerts default to sanitized structured logs; an injected adapter can forward them. | **Implemented/tested in unit tests; operations unverified.** There is no configured shared exporter, dashboard, paging destination, threshold, on-call route, or alert-delivery proof. Metrics are not exposed through public readiness. |
| Rollback and backups | `docs/DEPLOYMENT_AND_ROLLBACK.md` recommends application rollback over additive schema, forward corrective migrations, preserving migration metadata and financial history, and stopping after partial migration failure. It calls for encrypted backups/PITR and a restore into an isolated target. | **Documented, not operationally verified.** No staging backup/restore, RPO/RTO, compatibility window, rollback rehearsal, or recovery owner is evidenced. |
| Staging providers/features | Production composition requires a KMS envelope adapter and shared Redis-backed rate limiting. Evidence storage and email have unavailable/disabled defaults. Payment, escrow execution, refunds/Route, AI and blockchain have feature gates and provider configuration; the deployment guidance says keep these disabled until each gate is approved and tested. | **Blocked/unverified.** Staging-only KMS/Redis and any enabled adapters must be provisioned and tested. Do not enable financial or external features solely because configuration validates. |

## Required configuration contract (names only)

Required for production-mode composition: `NODE_ENV`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `RATE_LIMIT_STORE=redis`, `REDIS_URL` (production requires TLS and ACL credentials embedded in the secret-managed URL), `RATE_LIMIT_KEY_SECRET` (distinct from JWT secrets), `MFA_ENCRYPTION_PROVIDER=kms`, `MFA_KMS_KEY_ID`, `MFA_KMS_KEY_VERSION`, and `TRUSTBRIDGE_COMPOSITION_MODULE`. The module must export `createApplicationDependencies({ environment })` and return the approved KMS envelope adapter plus adapters for any explicitly enabled features.

`PORT` and JWT issuer/audience, CORS and rate-limit controls have validated defaults; deployment owners still need to set and review them. `SHUTDOWN_DRAIN_TIMEOUT_MS` is bounded and defaults to 30 seconds. Optional feature groups include `PAYMENT_ENABLED` and payment credentials, `ESCROW_EXECUTION_ENABLED`, `RAZORPAY_REFUNDS_APPROVED`, `RAZORPAY_ROUTE_APPROVED`, `AI_ENABLED` and `BLOCKCHAIN_ENABLED` with their associated settings. Keep all optional features off in initial staging unless separately authorized. Email and evidence storage currently depend on injected adapters, not established provider environment variables.

No environment files or actual environment values were read. The deployment module and credentials are external inputs and must be validated in a staging secret manager without printing them.

## Migration and failure-recovery procedure

1. Select an isolated staging PostgreSQL target and record its identity. Review the full ordered migration set and the deployed `_prisma_migrations` state read-only; the 16 local migration directories alone do not establish what is pending.
2. Review migration SQL, including the two same-prefix migrations, for dependencies and compatibility with both current and rollback application artifacts.
3. Take a backup and verify restoration into a separate isolated target against approved recovery objectives.
4. Run one serialized migration job using the reviewed application commit and lockfile with the pinned Prisma CLI available. The production-only web install may omit this development dependency. Use `prisma migrate deploy`; never `db push`, reset, manual recreation, or startup-time migrations.
5. If migration fails, halt rollout, preserve `_prisma_migrations`, inspect catalogs read-only, and invoke the approved database-owner recovery procedure. Do not mark a migration resolved or reverse schema manually without evidence and authorization.
6. Deploy the application artifact only after migration success and compatibility checks. Prefer rolling the application artifact back while preserving additive schema. Use a forward corrective migration when needed; reverse/destructive migration is not the default rollback.

No migration command, database connection, or schema change was performed for this assessment.

## Pre-deployment checklist

### Before a hosting platform is selected

- [ ] Keep production runtime requirement at Node 24 or 26; run the full relevant suite under the selected supported runtime, not Node 22.
- [ ] Verify package-lock reproducibility and inspect the production artifact contents, including absence of secrets and unnecessary development tooling.
- [ ] Review the complete migration SQL set and same-prefix ordering/dependencies; write a migration-job and failure-recovery runbook.
- [ ] Finalize disabled-by-default feature-gate policy and the dependency contract for KMS/Redis; keep production adapters external and fail closed.
- [ ] Define operations ownership for failed outbox rows, indefinite transient retry, metrics export, alert escalation, and shutdown timeout response.
- [ ] Correct stale readiness statements in `DEPLOYMENT_GUIDE.md` and `DEPLOYMENT_AND_ROLLBACK.md`: current code gates readiness on an enabled required escrow worker; notification/blockchain are optional.
- [ ] Establish staging acceptance evidence for provider adapters, alert delivery, shared metrics, backup restore, and worker/lease recovery.

### After platform selection, before traffic

- [ ] Provision isolated staging PostgreSQL and migration-job identity; authenticated TLS Redis with ACLs; non-production KMS key and workload permissions; private evidence storage if evidence APIs are in scope.
- [ ] Supply secret-manager values for required environment names and a reviewed composition module. Confirm no values appear in startup logs, health output, artifact, or CLI arguments.
- [ ] Verify DB pool, TLS/network rules, Redis health and cross-instance shared rate-limit behavior, KMS encrypt/decrypt/key-version behavior, and adapter outage fail-closed behavior.
- [ ] Verify optional email/recovery adapters only if enabled; keep payment, refund/Route, AI and blockchain disabled until approved staging credentials, policy and test evidence exist.
- [ ] Verify migration preflight, backup, migration job, schema parity, rollback compatibility, and restore drill.
- [ ] Configure supervisor grace longer than the maximum application drain period; test worker crash, lease expiry/reclaim, and repeated shutdown.
- [ ] Configure external metrics and paging/log routing with operational owners and tested delivery; the current default is process-local metrics plus structured logs, not shared monitoring.

## Deployment and rollback sequence

1. Confirm the release owner, target identity, artifact digest, runtime, configuration inventory, disabled feature flags, backup result, migration plan, and rollback/incident owner.
2. Run the serialized migration job and verify its recorded status and schema compatibility.
3. Start the application with external composition dependencies. Confirm startup fails closed for missing required adapters; do not route traffic until dependencies recover.
4. Check `/health/live`, then `/health/ready`; confirm DB, shared Redis, KMS, lifecycle, and any required escrow worker status. Route a small controlled staging cohort only after readiness is healthy.
5. Run non-financial smoke and acceptance tests. Do not use real money or real user evidence. Keep optional provider features disabled unless a separate written gate permits a staging-only test mode.
6. On application defect, stop traffic, disable optional execution gates, gracefully drain, and roll back the application artifact only if it is compatible with the migrated schema. Preserve ledger, outbox, and migration records.
7. On migration failure, halt. Preserve evidence and migration metadata, invoke database-owner recovery, and do not perform an unapproved reverse migration. Re-enable workers/features only after reconciliation and readiness are confirmed.

## Post-deployment acceptance checks

- Supported runtime and artifact digest recorded; startup reports no secrets.
- Missing/invalid composition, KMS or Redis fails closed; recovery returns readiness after dependency restoration.
- Liveness remains distinct from readiness; required escrow-worker failure makes readiness unhealthy, while optional worker status is visible without changing liveness.
- Graceful drain closes listener first, waits for active requests/jobs, reports timeout honestly, and permits lease recovery after forced termination.
- Migration status and schema parity match the reviewed release; backup restoration has passed in an isolated target.
- Two staging instances share rate limits; metrics/alerts arrive through the approved operational destination without sensitive labels.
- Outbox pending/failed/stale-lease visibility and triage ownership are verified; no unexpected retry storm or stale lease remains.
- Non-financial auth/profile/transaction/dispute smoke tests pass with external money-moving features disabled.
- Rollback drill proves application rollback does not reverse migrations or alter immutable financial history.

## Decisions, owners, and blockers

| Decision / evidence | Owner role | Status |
|---|---|---|
| Hosting platform, region, networking, TLS, workload identity, process supervision and termination grace | Platform/Operations | **Pending** |
| Staging database version, migration owner, backup/PITR, RPO/RTO, restore and incident recovery procedure | Database owner / Operations | **Pending** |
| Staging KMS implementation, key policy, rotation and recoverability | Security / Key-management owner | **Pending** |
| Shared Redis service, ACL/TLS, availability and key handling | Platform/Security | **Pending** |
| Shared metrics exporter, alert route, thresholds, escalation and on-call ownership | Operations/SRE | **Pending** |
| Failed outbox investigation/replay authority and policy for indefinitely retrying transient events | Finance operations / Engineering / Security | **Pending** |
| Private evidence storage and email/recovery delivery provider and retention policy | Product / Privacy / Security / Operations | **Pending** |
| Razorpay staging and Route/refund approval; settlement and financial-operation gates | Finance / Legal / Provider operations | **Pending** |
| AI provider, data egress/privacy controls and blockchain network/signer/testnet | Product / Security / Legal | **Pending** |

### Recommendation

**NO-GO for controlled staging deployment now.** The platform and isolated staging environment do not exist as verified targets, required production-mode KMS and Redis adapters have no staging proof, no migration/restore rehearsal exists, and current deployment guidance conflicts with the implemented worker readiness policy. This is not a claim that the code cannot run in staging: after the listed owners resolve infrastructure and operational prerequisites, proceed through the checklist with optional financial/external operations disabled. The assessment ran no tests or external checks and made no code or infrastructure changes.
