# TB-BE-066 — Escrow Outbox Poison-Event Handling

## Behavior

Escrow outbox claims remain bounded and conditional: candidates are `PENDING` and due, or `PROCESSING` with an expired lease. Each successful claim increments `attemptCount` and sets a 60-second lease owner. Completion/failure updates remain conditional on the current event ID, `PROCESSING` status, and lease owner.

Before invoking the escrow operation executor, the worker validates the persisted event-to-operation binding using the existing records: operation UUID and existence, event key, event type versus operation type, transaction aggregate/link, integer-minor amount, and currency. A malformed or inconsistent binding is terminally marked `FAILED` with `ESCROW_OUTBOX_INVALID_EVENT`; the row is retained, its lease is cleared, and the worker reports it in a separate `failed` count. The executor is not called for these events, so this path cannot post a journal or alter escrow, payment, or transaction state. `FAILED` rows are not selected for automatic replay.

Database lookup failures and all operation/executor errors remain on the existing transient path: return the event to `PENDING`, clear its lease, set a sanitized generic diagnostic code, and schedule another attempt 60 seconds later. Ambiguous provider outcomes remain pending for existing reconciliation. No retry ceiling or new backoff policy was introduced.

## Tests and limits

- `node --test tests/unit/escrow-ledger.test.js tests/unit/escrow-outbox.worker.test.js`: **15 passed, 0 failed**.
- `npm.cmd test`: **425 passed, 0 failed, 11 skipped** (436 total including nested tests).
- Unit tests cover invalid binding terminalization and replay exclusion, transient database failure and unchanged retry timing, expired-lease reclaim, and competing claims using independent service instances over a deterministic conditional-update mock.
- These mock tests do not prove PostgreSQL row-update concurrency. Existing isolated PostgreSQL escrow coverage was not run for this task.

## Operational decisions still open

The `FAILED` row is preserved for investigation, but retention duration, operator ownership/review, approved manual replay or repair procedure, and alert destination/escalation remain undecided. No automatic replay, dead-letter cleanup, notification, or financial repair is implemented. Transient failures continue retrying without an outbox attempt ceiling, consistent with the existing escrow behavior; an operations policy for long-lived transient failures remains needed.

No schema, migration, dependency, database, or provider changes were made. No development or production database was accessed.
