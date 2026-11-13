# TB-BE-067 — Worker and Outbox Operational Metrics

## Implementation

Added `createOperationalMetricsAdapter`, a provider-neutral, bounded metric registry. It accepts only fixed metric names and enumerated worker, state, outcome, and outbox-status labels; transaction IDs, event IDs, user data, provider references, evidence, and arbitrary labels are rejected. The default registry is in-memory and process-local. An injected sink can export the same low-cardinality samples; synchronous throws and asynchronous rejections are isolated from worker and financial processing.

The normal `createApp`/`startServer` path provides the adapter and outbox collector to notification, escrow, and blockchain workers. Metrics are kept in `app.locals` and are not returned by public health endpoints.

Implemented metric groups:

- Worker state gauges and transition counters for running, stopped, degraded, failed, and other lifecycle states.
- Worker run success/failure counters and processing-duration summaries (count, total, maximum).
- Per-worker batch claimed, succeeded/published, deferred, and failed counters.
- Aggregate outbox gauges by worker and persisted status, retry-count estimate (`sum(attemptCount) - event count`), expired processing leases, and oldest pending-event age.
- A safe counter for outbox metric-collection failures.

Outbox collection uses bounded-cardinality Prisma `groupBy` aggregates over known event types. Queries do not select row IDs, payloads, or financial data. Collection is throttled to once per minute per process by default, and errors do not propagate into workers. The interval is a sampling cadence, not an alert threshold or retention rule.

## Verification

- Focused: `node --test tests/unit/operational-metrics.test.js tests/unit/escrow-outbox.worker.test.js tests/unit/server-lifecycle.test.js tests/integration/app.test.js` — **41 passed, 0 failed**. HTTP tests used local loopback permission.
- Full: `npm.cmd test` — **431 passed, 0 failed, 11 skipped** (442 total including nested tests).
- Tests cover counter/gauge/duration accuracy, label bounds, sink and collector failure isolation, outbox queue/retry/lease/age aggregates, worker lifecycle and batch metrics, and server injection. No database connection was made; aggregate behavior used a Prisma-shaped mock. No monitoring provider was contacted.

## Limitations and operational decisions

Metrics are process-local unless an approved sink is injected; they are not durable or shared across instances by default. No public metrics endpoint, exporter, dashboard, alert threshold, retention policy, or on-call destination is selected. PostgreSQL performance and metric accuracy against a live isolated database were not verified. A deployment must select and verify its metrics sink and collection/alert operations separately.
