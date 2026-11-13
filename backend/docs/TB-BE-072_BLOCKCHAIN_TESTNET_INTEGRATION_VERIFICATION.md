# TB-BE-072 — Blockchain Testnet Integration Verification

**Assessment:** Read-only, 2026-11-13. No network, wallet, deployment, transaction, secret, or environment file was accessed.

## Classification

**Integrated but testnet verification pending.** The repository contains an EVM JSON-RPC adapter, an executable Solidity commitment contract, persisted outbox/record workflow, confirmation/reorg reconciliation, and local Ganache integration tests. No selected network, external RPC/provider, testnet deployment, testnet signer custody, or testnet transaction evidence exists.

## Verified implementation

### Network and adapter

- `src/services/ethers-blockchain.adapter.js` uses ethers v6 `JsonRpcProvider` against a configured JSON-RPC URL and chain ID. This is a provider-neutral EVM adapter; no named network or commercial RPC provider is selected.
- Adapter initialization requires an injected signer, configured contract address and confirmation depth. Before writing, it verifies reported chain ID, deployed bytecode, and that the signer address is an authorized contract writer.
- `src/config/env.js` defines `BLOCKCHAIN_ENABLED`, RPC URL, contract address, chain ID, and confirmation depth (1–256). When enabled these settings are required; production RPC must use HTTPS or WSS. Documentation records blockchain integration as disabled by default. The application refuses to run enabled writes without an injected signing adapter.

### Contract and supported operations

- `contracts/TrustBridgeEventAnchor.sol` supports owner-controlled writer allowlisting, `anchor(bytes32 operationKey, bytes32 eventHash)`, and read-only `getEventHash`. Repeating the same operation/hash is idempotent; reusing an operation key with a different hash reverts. The contract is an anchoring prototype, not custody or payment functionality.
- `src/services/blockchain-event-hash.service.js` creates a domain-separated SHA-256 commitment over only transaction status-history fields (`transactionId`, version, previous status and new status). The database outbox payload contains a BlockchainRecord reference; the chain receives only a bytes32 operation key and event hash. No PII, payment data, evidence or raw status-history payload is intentionally submitted. Hashes can still expose correlation/equality and are not encryption.
- `prisma/schema.prisma` stores chain/network, contract reference, event hash, operation/idempotency key, transaction/block references, status and safe error code. It does not store signer private keys.

### Submission, confirmation, failure and idempotency

- `src/services/blockchain.service.js` uses durable PostgreSQL records and a leased outbox worker. It persists a provider transaction hash as `SUBMITTED`; it does not equate broadcast with confirmation.
- `reconcile` checks the contract's stored event hash, receipt, expected block number/hash, canonical block hash, successful receipt status, matching `EventAnchored` event and configured confirmation depth before returning `CONFIRMED`.
- Missing receipts, insufficient confirmations, mismatched receipt/event/block data and ambiguous errors remain pending or submitted. Verified reverts become `FAILED`. Retry state is sanitized; the outbox stops automatic retries after eight attempts. The same idempotency key is reused; an idempotency conflict is rejected.
- Reconciliation revisits pending/submitted/confirmed records. A possible reorg can demote a confirmed record to submitted and requeue the same commitment for verification. Chain state is tamper evidence only and never changes transaction, payment, escrow, dispute or ledger authority.

### Signing and key management

- The adapter accepts an externally constructed signer; the repository does not load a private key or seed phrase from application configuration. No KMS-backed blockchain signer, custody provider, key rotation/recovery process, or production signer integration is implemented or verified.
- A deployment must inject a narrowly scoped, approved signer and establish custody, authorization, rotation, recovery, monitoring and incident procedures outside this code. Current configuration validation does not itself establish signer custody or provider approval.

## Test evidence and limits

- `tests/integration/blockchain-local.test.js` compiles the contract and deploys it to an ephemeral in-process Ganache chain (chain ID 1337). It verifies writer authorization, hash anchoring, idempotency conflict rejection, and matching receipt reconciliation at one confirmation. This is a local test chain, not a public testnet.
- `tests/unit/blockchain.service.test.js` uses deterministic mocks to verify hash-only outbox payloads, leased processing, sanitized failure/retry, persisted confirmation and reorg requeue behavior. `tests/unit/blockchain-event-hash.test.js` verifies deterministic domain-separated hashing and exclusion of actor/reason fields. Environment/app tests verify disabled/default and fail-closed configuration.
- `docs/TESTING_PLAN.md` records blockchain-focused tests **7/7** and a historical full suite **365 passed, 0 failed, 9 skipped** after TB-BE-043. These are historical records, not rerun for this assessment.
- There is no evidence of public testnet RPC execution, contract deployment, testnet transaction receipt/finality, testnet reorg handling, live signer permissions, or provider SLA/availability verification.

## Safe testnet verification path

The code has a configurable path, but it is not approved or ready to execute. Before using it, obtain ADR-007 network selection and explicit testnet approval; provision a dedicated non-production RPC endpoint, test-only contract deployment and funded test wallet; inject a signer through an approved test-only custody mechanism; and set chain ID, contract address and a project-approved confirmation depth. Keep payment, escrow execution, refund/Route, AI and production blockchain settings disabled. Verify writer allowlisting and startup chain/bytecode checks, submit only synthetic status-history commitments, record transaction/receipt/block evidence, then test duplicate submission, retry, timeout, insufficient confirmations, revert and reorg reconciliation. Never reuse a production key or deploy to mainnet as part of this work.

The above is a proposed safe path, not evidence that approval, credentials or infrastructure currently exist.

## Remaining work and completion evidence

1. **Network and provider decision:** approve a specific testnet, chain ID, RPC provider/endpoint class, confirmation/finality policy and test budget (Product/Operations/Security).
2. **Contract review:** independently review the prototype, access control, idempotency, event semantics and deployment procedure; record approved source/bytecode/address (Security/Engineering).
3. **Signer custody:** approve testnet key generation, storage/injection, least privilege, funding, rotation, recovery and incident ownership; demonstrate no key leakage (Security/Key Management/Operations).
4. **Testnet deployment and evidence:** deploy the reviewed contract to the approved testnet and retain chain ID, address, deployment transaction/receipt, block reference and authorized writer verification (Blockchain/Platform Operations).
5. **End-to-end testnet run:** execute synthetic hash-only anchor and reconciliation cases; retain transaction hashes and receipts; prove idempotency, configured confirmations, failure/retry, duplicate delivery and reorg recovery without touching financial state (Engineering/QA/Security).
6. **Operations and privacy gate:** configure sanitized monitoring/alerts, RPC outage handling, cost controls, data/hash leakage review and disable/rollback runbook (Operations/Privacy/Security).

Declare the testnet integration verified only when these approvals and artifacts exist and end-to-end testnet results show a matching contract event and canonical successful receipt at the approved confirmation depth, with duplicate/retry/failure behavior verified and no business or financial state changed. Production remains separately blocked pending mainnet/network approval, independent audit, production signer custody and legal/security/operational approval.

No application code, dependencies, schema, migrations or documentation other than this assessment were changed. No tests were run for this read-only task.
