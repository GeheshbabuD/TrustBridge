# Deployment and Rollback Readiness

**Status (2026-11-07): NOT PRODUCTION-READY.** Hosting, production KMS, Redis, private evidence storage, recovery identity/delivery providers, payment/Route approval, and blockchain network/signer custody are not selected or verified. Live financial execution, AI, blockchain publication and provider-backed evidence/email must remain disabled until their specific gates are signed off.

Use the hosting-neutral procedure in [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md). Runtime standard: Node.js 24 or 26 LTS, selecting an actively supported LTS release; the package declares `engines.node ^24.0.0 || ^26.0.0`. No cloud/container platform is selected.

## Pre-deployment gates

1. Select the hosting/platform and production PostgreSQL version/region; establish workload identity, network boundaries, TLS, backups and restore objectives.
2. Provision production KMS and verify the injected envelope adapter against an isolated non-production key. Keep old key versions decryptable through rotation and test recovery/restore.
3. Provision authenticated TLS Redis with ACLs, dedicated DB/namespace and the same private rate-limit HMAC key across all instances. Verify readiness, outage fail-closed behavior, alerts and multi-instance counters.
4. Select and assess private object storage, malware scanning, retention/deletion workflow, identity verification and secure recovery-code/legacy-admin authorization delivery. Do not expose raw authorization tokens through ordinary routes/logs.
5. Complete Razorpay merchant/Route eligibility, legal custody and settlement review, sandbox webhook/reconciliation exercises, independent provider approval and finance-operation controls. Keep payments, refunds and transfers disabled until authorized.
6. Resolve blockchain network and signer custody decisions, independent contract review, key rotation/recovery and testnet evidence. Keep blockchain disabled meanwhile.
7. Keep AI disabled pending provider, egress, privacy/retention and evaluation approval. AI remains advisory.
8. Run dependency/secret scans, full tests, staging load/reliability exercises, restore/rollback drills and security review; document accepted residual risks.

## Release procedure

- Build an immutable artifact from a reviewed lockfile and record its digest. Never copy `.env` into build logs/artifacts.
- Run `npm.cmd test`, `npx.cmd prisma validate`, `npx.cmd prisma generate`, `npm.cmd ls --depth=0 --offline`, syntax/whitespace checks and all enabled isolated PostgreSQL/provider integration suites.
- Review every pending migration SQL. Confirm target identity and migration history with a read-only preflight. Take and verify a restorable backup before any production migration; run the approved migration set in a serialized migration job/tool artifact built from the same commit and lockfile with the dev-only Prisma CLI available. The web runtime should not be assumed to include Prisma CLI, and application startup does not auto-migrate. Never use reset, `db push`, manual schema recreation or blanket destructive SQL.
- Deploy with money-moving features disabled. Verify health/liveness, database readiness (`/health/ready` probes the database and reports `available` or `unavailable`), KMS/Redis dependency health, worker status/lease ownership, error rates and sanitized logs.
- Run non-financial smoke checks first. Enable one feature gate at a time only after provider authorization, reconciliation, alerting, an on-call owner and a tested disable path are present.

## Rollback and incident handling

- Prefer rolling application artifacts back while preserving additive schema. Do not run reverse/destructive migrations as a routine rollback; keep migrations backward-compatible across the rollout window and use a forward corrective migration when needed.
- Disable payment/refund/Route, AI, blockchain and email/provider execution gates before rollback or incident investigation. Stop workers gracefully; persisted leases expire and are reclaimed by the supported worker path. Avoid deleting outbox or financial rows.
- Never roll back financial history or mutate posted ledger entries. Reconcile provider state first; correct accounting only with an authorized compensating journal and audited workflow.
- If a migration has partially failed, stop deployment, preserve `_prisma_migrations`, inspect schema/catalog read-only, restore only under the approved recovery plan, and obtain database-owner approval before any repair.
- Rotate compromised provider/KMS/Redis credentials through the provider's supported process, retain necessary historical decrypt keys, revoke affected sessions where applicable, and preserve privacy-safe evidence/audit records.
- Verify service recovery, pending operation reconciliation, backups, alerts and incident timeline before re-enabling any gate.

## Current limits

- `/health/live` reports process liveness only. `/health/ready` probes database connectivity, rate-limit storage and production MFA encryption; it returns 503 if a required check fails. It includes sanitized worker/lifecycle state for observation, but optional worker status does not gate readiness and it does not prove provider, storage, email, backup or worker-lease health.
- Production `npm start` requires `TRUSTBRIDGE_COMPOSITION_MODULE`, an operator-maintained module exporting `createApplicationDependencies({ environment })` and returning an approved matching KMS envelope adapter plus any enabled optional adapters. Startup fails closed if module loading or adapter validation fails. Provider implementation/configuration and credential provisioning remain external decisions.
- Graceful shutdown closes the HTTP listener before worker drain. `SHUTDOWN_DRAIN_TIMEOUT_MS` is bounded to 1–300 seconds (default 30 seconds). If a worker has not confirmed completion at timeout, shutdown fails visibly, closes remaining HTTP connections and leaves DB/Redis open; it does not claim successful completion. Deployment supervisors still need a termination grace period and lease-recovery monitoring.
- The migration guide uses `npx prisma migrate deploy`; Prisma CLI is a development dependency. Define a separate reviewed migration job/build artifact that includes the CLI rather than assuming a production-only runtime install can execute it.
- Previous wording that readiness could report `database: not_checked` is stale and superseded: the current handler probes the DB and reports `available` or `unavailable`.
- Runtime contract verification on Node **24.22.1** with npm **11.6.2** passed the focused 34-test suite and the complete suite (**379 passed, 0 failed, 9 skipped**). This verifies code/tests on a supported Node 24 engine, not a hosted artifact or deployment.
- No production hosting target, tested production backup restore, production KMS, shared Redis deployment, evidence/email/recovery providers, Razorpay Route approval or blockchain testnet/signer setup is verified.
- The current test suite provides strong unit/HTTP and isolated PostgreSQL concurrency coverage but no production-like load targets or deployment rollback exercise. `npm audit` reported vulnerabilities in the installed dependency tree; registry-backed revalidation and production/dev graph separation remain required before release.


