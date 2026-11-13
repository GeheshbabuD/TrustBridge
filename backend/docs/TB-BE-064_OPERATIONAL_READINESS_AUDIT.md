# TB-BE-064 — Backend Operational Readiness Audit

**Assessment:** The backend has a sound portable startup and bounded-shutdown foundation, database-backed worker leases, sanitized request telemetry, and dependency-aware readiness checks. It is **not verified ready for controlled staging operations that depend on background processing**: worker failure does not fail readiness, the production status observer defaults to a no-op, and there is no configured alerting/queue-lag signal. Staging deployment, runtime-artifact compatibility, migration execution, restore, load and failover were not exercised in this assessment. Production readiness remains blocked by documented provider/platform and operational gates.

**Method:** Read-only source and documentation review. No tests were run, no database or external provider was contacted, and no `.env` or secret values were inspected.

## Operational review

| Area | Verified implementation | Existing evidence / limits |
|---|---|---|
| Startup/configuration | `src/config/env.js` validates config with Zod and safe field descriptions; production rejects local MFA encryption and requires KMS settings, Redis TLS/ACL settings and distinct rate-limit key material. `src/server.js:startConfiguredServer` loads the operator composition module before app creation; `src/config/application-composition.js:loadApplicationDependencies` requires an injected `kms-envelope` adapter and validates shared rate-limit storage. Invalid config/composition rejects before listening. | Unit coverage: `tests/unit/env.test.js`, `tests/unit/application-composition.test.js`; integration: `tests/integration/app.test.js`. This audit did not run tests or verify deployment-owned adapters. |
| HTTP startup/shutdown | `startServer` listens, then starts notification, enabled escrow and configured blockchain workers. Shutdown closes the listener first, stops workers, waits for active HTTP requests and worker promises within configured `SHUTDOWN_DRAIN_TIMEOUT_MS` (1–300 seconds; 30-second default), then disconnects Prisma and Redis. Timeout reports failure, closes remaining HTTP connections, and leaves shared resources open when worker completion is unconfirmed. Repeated shutdown shares one promise. | `tests/unit/server-lifecycle.test.js`, `tests/unit/escrow-server-worker.test.js`; `tests/integration/app.test.js`. No staging supervisor termination-grace test was run here. Listener bind errors have no explicit application-level status path; the process/runtime surfaces startup failure. |
| Worker lifecycle/concurrency | Worker timers prevent overlapping local ticks; DB conditional claims and leases coordinate multiple instances. Workers record sanitized state, failures, and last success/failure timestamps. `startServer` catches synchronous worker-start errors. Notification and blockchain use bounded retry with terminal `FAILED` after eight attempts; escrow executor attempts are capped and ambiguous outcomes remain pending for reconciliation. | Unit evidence: `tests/unit/escrow-outbox.worker.test.js`, `tests/unit/escrow-server-worker.test.js`, `tests/unit/notification.service.test.js`; blockchain coverage is in its service tests. Database lease behavior is represented in PostgreSQL suites, not rerun here. No independent worker process command exists; workers share the HTTP process. |
| Outbox/stale leases | Notification, escrow and blockchain workers query bounded eligible batches and conditionally claim pending or expired-processing rows. Stale leases become claimable after expiry. Notification retries use exponential delay and cap; blockchain retries cap; escrow processing schedules pending retry/reconciliation and uses operation attempt limits/leases. | Tests cover worker retry/concurrency paths in the cited unit suites and focused PostgreSQL suites documented in `TESTING_PLAN.md`. No queue-age, expired-lease or failed-item operational dashboard/alert is implemented in the inspected runtime. |
| Database lifecycle | `src/config/db.js:createDatabaseLifecycle` memoizes client creation/connect/disconnect, cleans up failed connects, sanitizes lifecycle errors, and permits retry after initialization/connection failure. Readiness probes `checkDatabase`; probe errors are hidden and result in 503. Prisma is closed after confirmed drain. | `tests/unit/db.test.js` covers shared lifecycle operations, retry, cleanup, idempotent disconnect and sanitized errors. No pool saturation metrics or staging failover test is evidenced. |
| Health/readiness | `/health` and `/health/live` report process liveness. `/health/ready` checks database, rate-limit store, and production MFA encryption; it returns sanitized 503 on required dependency failure and reports lifecycle/worker state. Production requires shared rate-limit storage and available encryption. Worker states are informational and do not affect readiness. | `src/app.js`; `tests/integration/app.test.js` covers healthy/unavailable DB, Redis/KMS and sanitized responses. No live provider/worker checks were run. Readiness does not cover object storage, email, payment, backup, provider reconciliation or queue lag. |
| Logging/correlation | `requestIdMiddleware` accepts a bounded safe caller ID or generates a UUID; `requestLogger.middleware.js` emits an allowlisted structured completion record containing timestamp, level, request ID, method, route template, status and duration. Error responses are sanitized. Worker state is exposed through sanitized readiness fields. | `tests/integration/app.test.js` has request-ID and error-sanitization cases. `writeStructuredLog` itself JSON-serializes arbitrary input and has no general redaction schema; current request logging constructs an allowlisted record. No centralized worker/application event sink or log-retention/access policy is verified. |
| Monitoring/alerting | Readiness and lifecycle/worker state are available for an external monitor to poll. | `startServer` defaults `onStatus` to a no-op; no metrics/alert delivery or operational dashboard is wired in the reviewed source. Deployment docs instruct operators to configure external monitoring. No actual monitor or alert route was exercised. |
| Deployment/migrations/recovery | `DEPLOYMENT_GUIDE.md` and `DEPLOYMENT_AND_ROLLBACK.md` describe portable startup, a separate serialized migration job with Prisma CLI, additive/forward correction, backup preflight, rollback limits, and provider gates. Startup does not auto-migrate. | Documentation is a procedure, not evidence of deployment. No target host, artifact inspection, pending-migration preflight, backup restore, rollback or failover run was performed. `package.json` declares Node 24/26; artifact execution on selected staging runtime remains unverified. |

## Findings

### HIGH — Worker failure can coexist with HTTP-ready status and has no default alert sink

`src/app.js:/health/ready` computes readiness from DB, rate-limit storage and production MFA encryption, not worker state. `src/server.js:startServer` records worker-start failure and calls `publishStatus`, but `onStatus` defaults to a no-op. Therefore an enabled escrow/notification/blockchain worker can remain `failed` or `degraded` while readiness is 200, with no built-in alert. This may leave outbox work unprocessed without an operational signal. Tests explicitly encode worker startup failure as observable but not a readiness gate in `tests/unit/server-lifecycle.test.js`.

**Minimum action:** define staging operational ownership and external alerts for worker failed/degraded state, queue age, expired leases and repeated retries; decide which enabled workers are required for a given deployment profile. Preserve optional-worker semantics where no feature depends on that worker.

### MEDIUM — Escrow outbox poison events can retry without a terminal outbox state

`src/services/escrow.service.js:processOutboxBatch` catches malformed payload/service errors and returns the claimed outbox row to `PENDING` with a one-minute retry and generic error code. Unlike notification/blockchain outbox handling, this path has no event attempt ceiling or terminal/dead-letter state. Executor operation attempts are capped, but malformed or permanently invalid outbox payloads may recur indefinitely and remain hard to distinguish operationally.

**Minimum action:** decide and document a bounded terminal/quarantine policy for permanently invalid escrow outbox events, with an operator-reviewed recovery path that preserves financial idempotency and never retries ambiguous provider operations blindly. Do not change financial execution semantics as part of this audit.

### MEDIUM — Operational telemetry is polling-only and does not expose queue/lease health

The application returns worker counters/timestamps from readiness, but no durable worker heartbeat, queue age, oldest pending event, lease-expiry count, terminal-failure count, DB pool pressure, or alert delivery is wired. A failed event may be visible only indirectly in persistence or a generic worker status. The deployment documentation calls for such monitoring, but this remains documented intent, not implemented/verified behavior.

**Minimum action:** define minimum staging metrics and alert thresholds with an operations owner, then expose them through an authenticated/internal operational boundary or external database/metrics integration; keep public health output sanitized.

### MEDIUM — Staging operations and recovery procedures are not evidenced

The deployment documents require a supported Node runtime, reviewed immutable artifact, separate migration job, backup/restore, shutdown, rollback, load and failover exercises. No staging target/artifact or restore/release exercise is evidenced in the reviewed docs. This is a verification blocker rather than a source defect.

**Minimum action:** after platform selection, run a controlled staging rehearsal and record artifact/runtime, migration preflight, restore proof, graceful termination, worker lease recovery, queue alert, rollback and failover evidence.

### LOW — Logger helper relies on callers to provide safe fields

`src/utils/logger.js:writeStructuredLog` serializes any supplied object without redaction. Current HTTP logger uses a narrow allowlist and is safe by construction; worker status is sanitized. Future callers could accidentally serialize sensitive fields if they pass raw errors or payloads.

**Minimum action:** preserve allowlisted log construction for all future operational events or adopt a structured field schema before adding worker/provider logs. No current secret leak was confirmed.

## Staging blockers

1. Choose/provision an isolated staging platform and dependencies; production is not part of this task.
2. Provide approved staging KMS, TLS Redis, private evidence storage, email/recovery and other needed adapters through the documented composition module; keep unsupported features disabled.
3. Establish worker/outbox failure alerts and the required-worker policy before enabling workflows that depend on background execution.
4. Exercise migration job, backup/restore, graceful shutdown, lease recovery, queue retry and staging end-to-end smoke checks on the selected Node 24/26 runtime.
5. Inspect and execute the actual immutable artifact; documentation and unit/HTTP tests alone do not verify packaging.

## Production blockers

Hosting/region/network and production PostgreSQL are undecided; production KMS/Redis/storage/email/recovery providers and credentials are not provisioned or verified; Razorpay/Route legal/provider approval and settlement evidence remain open; blockchain network/signer custody remains open; dependency audit revalidation, production artifact inspection, security review, backup/restore, load/failover and incident alerting remain outstanding. No production readiness is claimed.

## Prioritized minimal roadmap

1. **Operational policy:** name staging service/operations owners; define critical versus optional worker behavior, alert ownership, escalation and outbox terminal-event review.
2. **Observability:** implement the minimal worker/queue/lease metrics and alerts needed by that policy, including escrow poison-event handling decisions.
3. **Staging rehearsal:** provision only after platform/provider decisions; verify Node 24/26 artifact, configuration failure, readiness, worker start/failure, retry/lease recovery, migration-job procedure and shutdown timeout.
4. **Recovery proof:** run and record isolated backup restore, rollback/forward-correction drill and dependency failover exercises with explicit RPO/RTO.
5. **Release gates:** complete dependency/security scan and production security review; keep payments, transfers, AI and blockchain disabled until their individual approval and reconciliation gates pass.

## Evidence not collected in this assessment

No tests were run. No host, database, Redis, KMS, email, payment, evidence-storage or blockchain endpoint was accessed. Database identity, migration state, provider connectivity, target runtime/artifact, backup integrity, real monitoring and alert delivery remain unverified. Existing test files and documentation were reviewed as evidence references only.
