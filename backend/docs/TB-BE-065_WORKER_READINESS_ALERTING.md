# TB-BE-065 — Worker Readiness and Alerting

## Implemented behavior

- The server observes notification, escrow, and blockchain worker status changes through the existing worker lifecycle callback. Observer failures are isolated from worker execution.
- Startup exceptions and runtime transitions to degraded, failed, stopped, or drain-timeout states are reflected in the sanitized worker status exposed by `/health/ready`.
- A configured escrow worker is readiness-required. Notification and blockchain workers remain optional; their failures produce operational status alerts but do not gate readiness. An absent worker is reported as disabled.
- `/health/live` remains a process-liveness check and does not fail when a worker is unavailable.
- A provider-neutral `operationalAlertAdapter.notify(alert)` interface accepts only allowlisted worker names, alert types, states, timestamps, required flags, and generic error codes. The default adapter emits sanitized structured logs. An injected adapter may forward the same safe event to an approved operational system.
- Alert dispatch is best-effort and isolated. Adapter rejection or logger failure cannot escape into worker execution. No payment, user, transaction, stack, provider-error, or secret data is included in alert payloads or readiness responses.

## Verification

- Focused: `node --test tests/unit/server-lifecycle.test.js tests/integration/app.test.js` — **33 passed, 0 failed**. Local loopback permission was required for the HTTP assertions.
- Full: `npm.cmd test` — **422 passed, 0 failed, 11 skipped** (433 total including nested tests).
- No database, provider, or live alert service was contacted. No schema, migration, dependency, or lockfile changes were made.

## Operational limitation

The default alert destination is the application's structured logger; this does not guarantee delivery to an on-call paging system. A deployment must inject a provider-neutral adapter through normal composition and separately verify delivery, monitoring, and escalation. The readiness policy covers worker availability, not alert-channel availability.

TB-BE-065 is implemented and test-verified within this scope. Overall deployment readiness remains unverified.
