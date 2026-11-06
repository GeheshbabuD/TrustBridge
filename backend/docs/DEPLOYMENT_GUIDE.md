# Hosting-Neutral Deployment Guide

Status: portable deployment contract; **not a deployment record**. No host, production database, KMS, Redis, object store, email or payment provider has been selected. Provider-specific values below are replaceable deployment configuration, not recommendations.

## Runtime and process

- Use Node.js 24 or 26 LTS (`package.json` declares `engines.node ^24.0.0 || ^26.0.0`); select only a release currently in LTS support. Confirm current status on the [official Node.js release schedule](https://nodejs.org/en/about/previous-releases). The current package start command is `npm start`; development uses `npm run dev`. Both invoke `node --experimental-strip-types` because the generated Prisma client runtime currently uses a TypeScript entry file. The default PATH runtime is Node 22.14; focused tests also ran successfully on Node 24.22.1. Verify `npm start` and the built artifact on the selected Node 24/26 LTS before deployment.
- Application code is JavaScript ES modules. `npm start` validates configuration, loads production dependencies through the configured composition module, constructs `createApp`, then starts HTTP. `SIGINT`/`SIGTERM` first closes the listener to new connections, then drains active requests and stops workers, then closes Prisma and Redis. `SHUTDOWN_DRAIN_TIMEOUT_MS` defaults to 30 seconds (validated range 1–300 seconds). On timeout, active HTTP connections are closed and shutdown reports failure; DB/Redis are deliberately left open while worker completion is unconfirmed. Leased jobs remain recoverable by lease expiry/retry after process termination.
- Notification and eligible escrow workers start with the HTTP process; blockchain worker starts only when configured. Database leases protect distributed work. No standalone worker process command or container build/compose file currently exists. Operate multiple replicas only with shared PostgreSQL/Redis and the existing leases; independent worker scaling requires a future process-role entry point.
- Use an immutable artifact built from `package-lock.json`; install production dependencies only for runtime where the build strategy permits. Do not copy `.env`, local keys, test fixtures, or development `node_modules` into artifacts. Artifact contents have not been verified.

## Configuration contract

`src/config/env.js` validates environment variables with Zod and exposes sanitized configuration. Supply secrets through the eventual platform's secret manager/workload identity; never put secret values in image layers, build output, documentation or logs.

Required production settings include `NODE_ENV=production`, `DATABASE_URL`, distinct `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`, `RATE_LIMIT_STORE=redis`, `REDIS_URL` using `rediss` plus ACL username/password, `RATE_LIMIT_KEY_SECRET` distinct from JWT keys, `MFA_ENCRYPTION_PROVIDER=kms`, `MFA_KMS_KEY_ID`, `MFA_KMS_KEY_VERSION`, and `TRUSTBRIDGE_COMPOSITION_MODULE`. The schema supplies defaults for `PORT` (3000), JWT TTLs (15m/7d), issuer/audience, CORS allowlist (empty), and API rate-limit window/maximum; explicitly set and review these for deployment instead of assuming they are required variables. Other MFA limits and operational bounds are likewise defaulted and validated in `src/config/env.js`.

Production MFA requires `MFA_ENCRYPTION_PROVIDER=kms`, `MFA_KMS_KEY_ID` and `MFA_KMS_KEY_VERSION`, plus an injected approved KMS adapter. Production startup loads an operator-maintained module from `TRUSTBRIDGE_COMPOSITION_MODULE` (absolute filesystem path recommended; relative paths resolve from the process working directory); it must export `createApplicationDependencies({ environment })` and return the `createApp` dependency object, including an adapter with `kind: "kms-envelope"`, matching `keyId`/`keyVersion`, and the KMS encryption methods. Optional email, private evidence storage, payment, AI and blockchain adapters belong in the same returned object only when approved/configured. The module should obtain credentials through the platform secret manager or workload identity; never log or serialize them. Missing or invalid module/KMS adapter stops startup. No provider is selected by this project. Local AES configuration remains development/test only.

Feature-specific values are optional while disabled: `AI_ENABLED` and `AI_PROVIDER`/`AI_ENDPOINT`/`AI_API_KEY`/`AI_MODEL_IDENTIFIER`/`AI_MODEL_VERSION`; `BLOCKCHAIN_ENABLED` and RPC/contract/chain/confirmation settings; `PAYMENT_ENABLED` and provider credentials/webhook secret; `ESCROW_EXECUTION_ENABLED`, `RAZORPAY_REFUNDS_APPROVED`, `RAZORPAY_ROUTE_APPROVED`. Keep financial, AI and blockchain operations disabled until their individual approval and staging gates pass. Email and evidence storage are injected provider interfaces with disabled/unavailable defaults; there are no production provider environment variables or adapters currently configured.

Other validated controls include `BCRYPT_SALT_ROUNDS`, `MFA_TOTP_WINDOW_STEPS`, `MFA_VERIFY_RATE_LIMIT_WINDOW_MS`, `MFA_VERIFY_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS`, `AUTH_LOGIN_RATE_LIMIT_MAX`, `MFA_CHALLENGE_RATE_LIMIT_WINDOW_MS`, `MFA_CHALLENGE_RATE_LIMIT_MAX`, `MFA_LOGIN_CHALLENGE_TTL_SECONDS`, `MFA_STEP_UP_CHALLENGE_TTL_SECONDS`, `MFA_ASSURANCE_MAX_AGE_SECONDS`, and AI timeout/rate-limit settings. Consult `src/config/env.js` and `.env.example` for bounds and defaults; do not copy example credentials into deployments.

## Build, migration and startup procedure

1. Build from a reviewed lockfile and record artifact digest. Run dependency/security scans and the verification checklist in `TESTING_PLAN.md`.
2. Provision isolated staging PostgreSQL, Redis, KMS, private evidence storage and other approved provider adapters. Verify readiness and fail-closed behavior before traffic.
3. Review every pending Prisma migration SQL. Confirm target identity and migration history read-only; take and verify a restorable backup. Run migrations in a separate, serialized deployment job/tool artifact built from the same commit and lockfile with the pinned Prisma CLI available (currently a `devDependency`). Provide only the approved target connection through the deployment secret mechanism; run `npx prisma migrate deploy` after preflight and before application rollout. Do not assume the production-only web runtime contains Prisma CLI, and do not run migrations automatically during HTTP startup. Never use `db push`, reset, manual schema recreation or destructive cleanup.
4. Start with `npm start`. Keep business execution flags disabled until signed approval and staging verification. Workers currently share the HTTP runtime and are stopped during graceful shutdown.
5. Verify `/health/live` (process only) and `/health/ready` (database connectivity, rate-limit store and production MFA encryption). Readiness includes sanitized lifecycle and worker state (`running`, `degraded`, `failed`, etc.) for observation but optional workers do not gate readiness. It is not a full provider/worker lease health report; inspect sanitized logs/metrics and outbox lag separately.

## Storage, backups and operations

- Evidence content belongs in approved private object storage, not PostgreSQL. Current default storage adapter is unavailable; evidence upload/download fails closed until a provider is injected. Configure encryption, private access, malware scanning, retention and audited deletion at the selected provider boundary.
- PostgreSQL stores transactional records and immutable financial history. Define encrypted backups, retention, point-in-time recovery and RPO/RTO with the eventual platform. No production backup/restore exercise has been run; prove restore into a separate isolated target before launch.
- Use structured request IDs and privacy-safe logs. Exclude credentials, tokens, TOTP/recovery codes, evidence contents, payment payloads and plaintext secrets. Configure platform monitoring for readiness, error rates, queue/outbox age, worker leases, database pool pressure, Redis/KMS availability and provider reconciliation backlog.
- Test shutdown, deployment rollback and recovery in staging. Preserve additive schema and ledger immutability; resolve financial operations against provider evidence before restoring workers.

## Staging checklist

- [ ] Hosting, region, network, TLS, workload identity, database and operational owners approved.
- [ ] Node 24 or 26 active LTS runtime and generated Prisma runtime verified in the built artifact.
- [ ] Production dependency artifact inspected; no development tools or secrets included.
- [ ] KMS, Redis TLS/ACL, object storage, email and recovery adapters approved and exercised in isolated staging.
- [ ] Migration preflight, backup and forward deployment procedure rehearsed; restore verified against approved RPO/RTO.
- [ ] Health/readiness, alerts, sanitized logging, worker lease behavior and graceful shutdown verified.
- [ ] Payment/Route, AI and blockchain remain disabled unless each separate provider, legal, security and operational gate is approved.
- [ ] Load, failover, rollback, security review and final end-to-end regression evidence recorded.

Deployment readiness remains **BLOCKED** until these gates are evidenced. See `REMAINING_WORK_ROADMAP.md` and `DEPLOYMENT_AND_ROLLBACK.md`.





