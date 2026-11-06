# Remaining Backend Work Roadmap

Status consolidated 2026-11-06. TB-BE-092, TB-BE-050 and TB-BE-041 are complete for their implemented scopes. The latest full suite passed 366 tests, failed 0, with 9 opt-in skips. This is not a production-readiness determination.

## A. Infrastructure and provider decisions

| Priority | Work | Dependency / decision | Completion criteria |
|---|---|---|---|
| P0 | Select hosting platform and production PostgreSQL service | Hosting, data residency, network and operational ownership decisions | Approved target; deployment and migration plan; identity-verified staging environment |
| P0 | Production KMS and key management (TB-BE-035) | Select provider and key custody/rotation/incident owners | Real non-production provider integration verified; production fail-closed configuration, rotation and recovery procedures tested |
| P0 | Shared Redis deployment (TB-BE-035 / TB-BE-044A) | Approved Redis service, TLS, ACL, network and secret handling | Real isolated multi-client verification; outage/recovery and readiness behavior pass; no local fallback in production |
| P0 | Identity verification and secure recovery delivery (TB-BE-035) | Approve providers and operational governance | Independently verified workflow and delivery; audited recovery, bootstrap and abuse controls tested |
| P1 | Email provider (TB-BE-041) | Select provider and configure sender/domain and credentials | Staging delivery, idempotency, bounce/retry and secret-redaction checks pass; production remains opt-in |
| P1 | Payment provider and Route staging approval (TB-BE-038/039/070) | Provider account capability, legal/operational approval and isolated staging credentials | Verified signed events, refunds/transfers/reconciliation and failure handling in provider test environment; live operations remain separately gated |
| P1 | Blockchain network, signer custody and testnet approval (TB-BE-043) | Approve network, custody, contract and testnet access | Independent contract/security review, testnet finality/reorg tests, custody and rotation procedures |

## B. Engineering and validation

| Priority | Work | Depends on | Completion criteria |
|---|---|---|---|
| P0 | Repeatable dependency audit/remediation (TB-BE-044A) | Registry access and lockfile/artifact policy | Reproducible production and development dependency reports; targeted fixes verified by regression tests; deployment artifact contents proven |
| P0 | Production deployment artifact verification | Hosting/build pipeline | Reproducible artifact inventory excludes development tools/secrets; configuration and readiness checks verified |
| P0 | Backup and restore exercise | Approved staging database/storage and retention policy | Documented, timed restore to isolated target; integrity and recovery objectives evidenced |
| P1 | Load and failover testing | Staging platform, Redis and provider-safe mocks/sandboxes | Representative load, database/cache/provider outage and recovery results meet approved targets |
| P0 | Production security review | Stable deployment architecture, KMS/Redis/storage/provider decisions | Independent review findings triaged and critical/high issues resolved or formally accepted |
| P0 | Final end-to-end regression | All above implementations and staging integrations | Auth, transaction, payment, escrow, dispute, AI, notification, audit and recovery journeys pass in isolated staging with no real-money operation unless separately approved |

## Current blockers and housekeeping

- TB-BE-035 remains IN PROGRESS; production KMS, shared Redis, independent identity verification and secure recovery delivery are paused pending infrastructure/provider decisions and verification.
- TB-BE-044A remains IN PROGRESS: advisory audit could not be reproduced after registry failures; current Redis endpoint verification is NOT RUN because the designated endpoint was unreachable.
- TB-BE-043 remains IN PROGRESS pending network, signer custody and testnet approval. TB-BE-044 remains IN PROGRESS pending deployment, dependency, restore, load/failover and security gates.
- `trustbridge_tb050_clean`, `trustbridge_tb050_isolated`, `trustbridge_tb050_verified` and `trustbridge_tb050_final` are retained diagnostic databases. Do not drop or modify them; cleanup requires explicit approval. No database operation occurred during this roadmap audit.
- Completed local tests establish implementation evidence only. Deployment readiness is BLOCKED until the infrastructure and validation gates above are met.

## Functional audit update (2026-11-06)

`BACKEND_FUNCTIONAL_AUDIT.md` is the current source/test-oriented module matrix. It found no safe provider-neutral MFA/recovery code correction to make in this pass. TB-BE-035 still needs production KMS, independent identity verification, secure delivery and shared Redis decisions/configuration; do not add an unauthenticated recovery path until its verification and delivery boundary is approved. MFA unit tests passed 46/46, but the focused HTTP run had 9 loopback connection failures and the full suite did not yield a final aggregate. Re-run those tests in an environment permitting local loopback. The roadmap/blueprint status reconciliation remains required.
