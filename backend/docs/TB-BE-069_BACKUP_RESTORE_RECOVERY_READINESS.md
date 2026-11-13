# TB-BE-069 — Backup, Restore and Recovery Readiness Assessment

**Assessment only — 2026-11-13.** No backup, restore, migration, database connection, provider operation, or test was performed. No backup product, retention duration, RPO, or RTO is assumed.

## Executive assessment

The application has durable PostgreSQL records, immutable/balanced-ledger safeguards, idempotent operation records, leases, and read-only escrow reconciliation. Documentation describes a safe migration and rollback approach. However, the repository does not implement or verify database backup/restore, point-in-time recovery, Redis persistence, KMS key recovery, or a complete restoration exercise. Recovery readiness is therefore **NO-GO for staging approval until owners choose recovery objectives and demonstrate isolated restore and post-restore checks**.

## Capability status

| Area | Implemented | Documented | Tested / verified | Assessment |
|---|---|---|---|---|
| PostgreSQL backup/PITR | No backup executor or platform integration was found in the reviewed application code. | `DEPLOYMENT_GUIDE.md` calls for encrypted backups, retention and PITR, but leaves implementation to the eventual platform. | No backup or restore exercise is recorded. | **Unverified / high gap.** Select a supported backup method, access controls, encryption, retention and restore owner. |
| Transactional consistency | Payment, escrow, ledger, webhook, outbox and reconciliation records are PostgreSQL-backed. Financial writes are transactional; schema constraints enforce journal invariants and journal/entry immutability. | `DATABASE_DESIGN.md` and `LEDGER_RECONCILIATION_DESIGN.md` describe the model and consistency expectations. | Unit and isolated PostgreSQL tests verify journal balancing, immutability, transactional rollback, idempotency, and snapshot-consistent reconciliation. These are not backup-restore tests. | **Implemented/tested at application level; restore-level consistency unverified.** A backup must be a transactionally consistent database recovery point, not independently copied tables. |
| Migration recovery | Startup does not auto-migrate. Deployment docs prescribe a serialized `prisma migrate deploy` job, preserving `_prisma_migrations`, stopping after failure, and preferring app rollback/forward migration over destructive reversal. | Documented in `DEPLOYMENT_GUIDE.md` and `DEPLOYMENT_AND_ROLLBACK.md`. | No staging migration failure or recovery drill. The production-only runtime may omit Prisma CLI because it is a development dependency. | **Documented; unverified.** Needs a separate migration-job artifact and tested failure runbook. |
| Ledger/escrow checks after restore | `createEscrowService(...).reconcileLedger({ transactionId })` is read-only and uses a repeatable-read snapshot. It detects ledger/escrow inconsistencies. The schema also has commit-time journal balance controls and immutability. | `LEDGER_RECONCILIATION_DESIGN.md`. | Unit and isolated PostgreSQL reconciliation tests exist, including a concurrent snapshot test; no restore-time all-record reconciliation has run. Batch reconciliation is persisted/orchestrated but currently manual/admin scoped. | **Partial.** Must reconcile the restored financial population before execution workers resume; exact coverage and signoff procedure are unverified. |
| Outbox and worker recovery | PostgreSQL outbox rows and operation records persist. Workers use conditional claims, leases, idempotency, and retry/reconciliation paths. Escrow leases expire after 60 seconds; terminal invalid events remain `FAILED`; transient escrow failures retry after 60 seconds without a ceiling. | `TB-BE-066_OUTBOX_POISON_EVENT_HANDLING.md`, deployment docs. | Worker and unit/integration tests verify leases, retries and duplicate protection; test evidence is not a restore/point-in-time recovery exercise. | **Implemented/tested in normal operation; restore replay risks unverified.** Post-restore workers must remain paused until DB/provider divergence is assessed. |
| Redis recovery | `src/services/rate-limit-store.service.js` uses Redis for shared, TTL-based counters (atomic increment/expiry); it does not store financial, session, ledger, or outbox records. Production fails closed if shared rate-limit storage is unavailable. | Deployment guide requires authenticated TLS Redis and operational checks. | Redis multi-instance verification is not currently available as a staging recovery test. | **Limited reconstructible state.** Counter loss can reset active rate-limit windows; restoring stale counters may preserve obsolete limits. Persistence/failover policy is provider-specific and unverified. |
| KMS recovery | Production MFA requires an injected `kms-envelope` adapter and configured key ID/version. MFA ciphertext is in PostgreSQL; key material and provider availability are external. | Deployment/rollback docs require historical decrypt key versions to remain available during rotation and restore. | Adapter unit tests do not establish provider key recovery, permission recovery, or decryptability after restore. | **External blocker.** A database backup alone cannot restore access to encrypted MFA secrets. |
| RPO/RTO and continuity | No recovery target is encoded in application behavior. | Docs say to define RPO/RTO with the selected platform. | No approved targets, failover test, restore timing or load test evidence. | **Pending business/operations decision.** |

## Financial data integrity requirements

The recovery point must preserve PostgreSQL transaction consistency across, at minimum:

- transactions and participant/terms/status history;
- payment attempts, captured payment references, verified webhook event identity and processing status;
- escrow balances and operation records;
- ledger accounts, journals, entries and reversal links;
- outbox event identity, payload, status, retry count, lease owner/expiry and idempotency references;
- reconciliation runs, frozen run items and finding identities/statuses; and
- audit records and migration history.

The journal and entries must be restored from the same consistent point. After restore, check that every posted journal balances, uniqueness/idempotency constraints remain valid, no orphaned financial links exist, and escrow projections agree with the corresponding ledger liability. Use the existing read-only reconciliation service; it reports inconsistencies and does not repair them. A successful database restore does not prove a payment was settled, an escrow was funded, or a payout/refund completed.

Provider-side state can be newer than the chosen database recovery point. Payment capture, webhook delivery, refunds, Route transfers, email deliveries, identity decisions and any test-mode provider events must be reconciled against authoritative provider records before resuming affected workers or enabling financial actions. Never replay solely from a restored `PENDING` row or infer success/failure from a missing event.

## Migration recovery considerations

- Migration directories are immutable deployment history; preserve `_prisma_migrations` and use the reviewed chain. Do not reset, delete migration metadata, use `db push`, or mark a migration applied without evidence.
- Before migration: verify target identity and migration status read-only, inspect pending SQL, create and verify a restorable backup, and ensure current and rollback application artifacts tolerate the schema transition.
- Run one serialized migration job using the same reviewed commit/lockfile and a tool environment containing the pinned Prisma CLI. Do not rely on the production-only web install to contain it.
- On partial failure: stop rollout; preserve error and migration metadata; inspect catalogs read-only; restore to a separately isolated target if the approved recovery plan calls for it; obtain database-owner approval before any repair. Prefer an additive forward corrective migration over reverse/destructive SQL.
- No migration compatibility window, actual target schema parity, failure recovery or restore-based rollback has been exercised for staging.

## Redis and KMS recovery dependencies

**Redis:** rate-limit keys are ephemeral counters with configured TTLs and may be recreated by traffic. The application can fail closed while Redis is unavailable, and readiness should remain unhealthy. An empty/replaced Redis instance may reset current windows; this changes abuse-control state but must not change financial/account state. Decide whether Redis persistence/failover is required for rate-limit policy, how to prevent an unsafe process-local fallback, and how to monitor reinitialization. Do not back up/restore Redis as a substitute for PostgreSQL recovery.

**KMS:** recovery requires the approved provider, key policy and workload identity to remain available, including decrypt access to every key version needed by restored ciphertext. Rotation must preserve old-key decryption until data is re-encrypted under an approved process. A key disabled, deleted, inaccessible or regionally unavailable can make restored MFA secrets unusable even when PostgreSQL is intact. Security/key-management owners must document provider-native recovery, access restoration and tested non-production decrypt verification; do not export or place key material in database backups.

## Safe isolated recovery-exercise plan

1. Approve a disposable, isolated staging-recovery target distinct from development, production and ordinary test databases; document identity and owners. Provision only synthetic staging fixtures and test-mode provider accounts where explicitly approved.
2. Approve RPO/RTO, backup type, encryption, access controls, retention and the restore decision tree before creating a backup. Record source artifact/schema/migration identity without recording credentials.
3. Create a backup using the selected platform-supported method. Verify its integrity and restore it into a separate isolated target; never overwrite the source.
4. Keep HTTP traffic and all workers disabled during validation. Restore PostgreSQL, apply no ad hoc schema changes, and verify migration metadata/schema parity.
5. Run structural checks: foreign keys/constraints, balanced immutable journals, escrow-to-ledger reconciliation, payment/webhook/operation links, idempotency uniqueness, outbox and reconciliation records, and counts/checksums of agreed non-sensitive record classes. Reconciliation is diagnostic only.
6. Verify KMS access and decryption using synthetic non-production MFA ciphertext and approved historical key versions. Verify Redis is configured as shared TLS storage; test outage/recovery and document the counter-reset implication without importing production keys or state.
7. Before resuming workers, compare restored pending/processing payment, escrow, notification and blockchain operations with authoritative provider/test systems. Preserve ambiguous outcomes for reconciliation; do not blindly replay financial operations. Expired leases may be reclaimed by workers, so verify idempotency and provider references first.
8. Start workers in a controlled order with financial execution disabled; verify readiness, logs, alerts/metrics, lease recovery, safe retry, and that no duplicate provider operation is emitted. Conduct only synthetic or provider sandbox tests.
9. Measure elapsed restore and service recovery against approved RTO; quantify data loss against approved RPO. Record failures, recovery owner decisions, evidence, and required remediation. Repeat after significant migration, provider or backup-policy changes.

This is a recommended exercise, not a claim it has been executed.

## Severity-ranked gaps

### Critical

- **No verified restorable backup or recovery target.** Production/staging data loss and prolonged outage consequences are unknown. Owner: platform/database operations.
- **No approved RPO/RTO or restore authority.** Recovery cannot be judged acceptable or prioritized. Owners: product/business continuity, finance, security and operations.

### High

- **No isolated restore and financial-integrity validation exercise.** Application-level database tests do not prove a backup restores all linked ledger, escrow, payment, outbox and audit records consistently. Owner: database operations/finance engineering.
- **KMS historical-key recovery is not verified.** Database restoration can succeed while MFA ciphertext becomes undecryptable. Owner: security/key management.
- **No post-restore provider reconciliation/runbook before workers resume.** Stale outbox/payment states can lead to duplicate or misclassified external operations. Owners: finance operations/payment operations/engineering.

### Medium

- **Redis durability/failover behavior and rate-limit counter reset policy are undecided.** Redis holds reconstructible TTL counters but loss resets active limits. Owners: platform/security.
- **Migration partial-failure recovery and rollback compatibility are documented but not rehearsed.** Owners: database owner/release operations.
- **Outbox terminal-failure triage and indefinite transient retry ownership are unresolved.** Owners: operations/finance engineering.

### Low

- **Restore evidence, backup inventory, artifact/schema association, and periodic exercise cadence have no approved record format/cadence.** Owner: operations/compliance.

## Decisions, owners and staging blockers

| Decision/evidence required | Responsible owner role | Status |
|---|---|---|
| Backup/PITR method, encryption, retention, access separation and restore cadence | Platform and database operations | Pending |
| RPO/RTO and acceptable data-loss/outage thresholds | Product/business continuity with finance and operations | Pending |
| Recovery approval authority, incident roles and isolated restore target | Operations/security/database owner | Pending |
| Ledger verification and provider reconciliation signoff before worker resume | Finance operations and engineering | Pending |
| KMS key-version recovery and workload permission procedure | Security/key management | Pending |
| Redis persistence/failover and rate-window reset expectations | Platform/security | Pending |
| Migration failure/forward-correction playbook and compatible rollback window | Database owner/release engineering | Pending |
| Outbox failed-event review, replay authorization and retry-storm response | Operations/finance/security | Pending |

Staging remains blocked until a platform and isolated target are selected, recovery objectives are approved, a restorable backup is proven, the financial integrity and provider reconciliation checks are run, KMS recovery is demonstrated, and workers can resume safely under an owned runbook.

## Recommended next actions

1. Product/finance/operations approve RPO, RTO, retention and recovery authority.
2. After platform selection, database operations choose a backup/PITR method and establish a separate isolated recovery target.
3. Security verifies KMS historical-key recovery; platform/security documents Redis reset/failover behavior.
4. Finance engineering and payment operations approve post-restore reconciliation and worker-resume gates.
5. Run and document the isolated recovery exercise above; remediate findings before staging GO.

No code or tests were changed or run for this assessment.
