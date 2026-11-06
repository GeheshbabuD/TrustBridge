import { randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { hashBlockchainOperationKey } from "./blockchain-event-hash.service.js";

const safeCode = "BLOCKCHAIN_PROVIDER_UNAVAILABLE";

/** Durable, optional commitment workflow. Chain results never authorize financial or transaction actions. */
export const createBlockchainService = ({ getClient = getPrismaClient, adapter, enabled = false, network, contractReference, now = () => new Date() } = {}) => {
  if (enabled && (!adapter || typeof adapter.submitAnchor !== "function" || typeof adapter.reconcile !== "function" || !network || !contractReference)) throw new TypeError("Enabled blockchain service requires configured adapter and network");

  const processOutboxBatch = async ({ limit = 20, leaseMs = 60_000 } = {}) => {
    if (!enabled) return { claimed: 0, published: 0, deferred: 0 };
    const prisma = await getClient(); const stamp = now();
    const candidates = await prisma.outboxEvent.findMany({ where: { eventType: "BLOCKCHAIN_ANCHOR", OR: [{ status: "PENDING", nextAttemptAt: { lte: stamp } }, { status: "PROCESSING", leaseExpiresAt: { lte: stamp } }] }, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: limit, select: { id: true } });
    const result = { claimed: 0, published: 0, deferred: 0 };
    for (const { id } of candidates) {
      const owner = randomUUID(); const claimedAt = now();
      const claim = await prisma.outboxEvent.updateMany({ where: { id, eventType: "BLOCKCHAIN_ANCHOR", OR: [{ status: "PENDING", nextAttemptAt: { lte: claimedAt } }, { status: "PROCESSING", leaseExpiresAt: { lte: claimedAt } }] }, data: { status: "PROCESSING", leaseOwner: owner, claimedAt, leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs), attemptCount: { increment: 1 } } });
      if (claim.count !== 1) continue;
      result.claimed += 1;
      const outbox = await prisma.outboxEvent.findUnique({ where: { id } });
      try {
        const recordId = outbox?.payload?.blockchainRecordId;
        if (typeof recordId !== "string") throw new Error(safeCode);
        const record = await prisma.blockchainRecord.findUnique({ where: { id: recordId } });
        if (!record) throw new Error(safeCode);
        const operationKey = `0x${hashBlockchainOperationKey(`${record.network}:${record.contractReference}:${record.idempotencyKey}`)}`;
        const outcome = await adapter.submitAnchor({ operationKey, eventHash: `0x${record.eventHash}` });
        if (!["SUBMITTED", "CONFIRMED"].includes(outcome?.status) || !outcome.transactionHash) throw new Error(safeCode);
        if (outcome.status === "CONFIRMED" && (outcome.blockNumber === undefined || !outcome.blockHash)) throw new Error(safeCode);
        await prisma.$transaction(async (tx) => {
          const persisted = await tx.blockchainRecord.updateMany({ where: { id: record.id, status: { in: ["PENDING", "SUBMITTED"] } }, data: { status: outcome.status, transactionHash: outcome.transactionHash, ...(outcome.blockNumber !== null && outcome.blockNumber !== undefined ? { blockNumber: BigInt(outcome.blockNumber), blockHash: outcome.blockHash } : {}), ...(outcome.status === "CONFIRMED" ? { confirmedAt: now() } : {}), submittedAt: record.submittedAt ?? now(), errorCode: null } });
          if (persisted.count !== 1) throw new Error(safeCode);
          const ack = await tx.outboxEvent.updateMany({ where: { id, status: "PROCESSING", leaseOwner: owner }, data: { status: "PUBLISHED", publishedAt: now(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null } });
          if (ack.count !== 1) throw new Error(safeCode);
        });
        result.published += 1;
      } catch {
        const attempts = outbox?.attemptCount ?? 1; const terminal = attempts >= 8;
        const delay = Math.min(60 * 60_000, 1000 * (2 ** Math.min(attempts, 12)));
        await prisma.$transaction(async (tx) => {
          const recordId = outbox?.payload?.blockchainRecordId;
          if (typeof recordId === "string") await tx.blockchainRecord.updateMany({ where: { id: recordId, status: { not: "CONFIRMED" } }, data: { errorCode: safeCode } });
          await tx.outboxEvent.updateMany({ where: { id, status: "PROCESSING", leaseOwner: owner }, data: { status: terminal ? "FAILED" : "PENDING", nextAttemptAt: new Date(now().getTime() + delay), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: safeCode } });
        });
        result.deferred += 1;
      }
    }
    return result;
  };

  const reconcilePending = async ({ limit = 50 } = {}) => {
    if (!enabled) return { checked: 0, confirmed: 0, pending: 0 };
    const prisma = await getClient();
    const rows = await prisma.blockchainRecord.findMany({ where: { status: { in: ["PENDING", "SUBMITTED", "CONFIRMED"] } }, orderBy: { updatedAt: "asc" }, take: limit });
    let confirmed = 0; let failed = 0; let pending = 0;
    for (const record of rows) {
      try {
        const operationKey = `0x${hashBlockchainOperationKey(`${record.network}:${record.contractReference}:${record.idempotencyKey}`)}`;
        const outcome = await adapter.reconcile({ operationKey, eventHash: `0x${record.eventHash}`, transactionHash: record.transactionHash, blockNumber: record.blockNumber, blockHash: record.blockHash });
        if (outcome?.status === "CONFIRMED" && outcome.transactionHash === record.transactionHash
          && (record.blockNumber === null || BigInt(outcome.blockNumber) === BigInt(record.blockNumber))
          && (record.blockHash === null || outcome.blockHash?.toLowerCase() === record.blockHash.toLowerCase())) {
          const changed = await prisma.blockchainRecord.updateMany({ where: { id: record.id, status: { in: ["PENDING", "SUBMITTED", "CONFIRMED"] } }, data: { status: "CONFIRMED", blockNumber: BigInt(outcome.blockNumber), blockHash: outcome.blockHash, confirmedAt: record.confirmedAt ?? now(), errorCode: null } });
          if (changed.count === 1) confirmed += 1; else pending += 1;
        } else if (outcome?.status === "FAILED" && outcome.transactionHash === record.transactionHash) {
          const changed = await prisma.blockchainRecord.updateMany({ where: { id: record.id, status: { in: ["PENDING", "SUBMITTED", "CONFIRMED"] } }, data: { status: "FAILED", blockNumber: BigInt(outcome.blockNumber), blockHash: outcome.blockHash, errorCode: "BLOCKCHAIN_TX_REVERTED" } });
          if (changed.count === 1) failed += 1; else pending += 1;
        } else {
          if (record.status === "CONFIRMED" && ["PENDING", "SUBMITTED"].includes(outcome?.status)) {
            await prisma.$transaction(async (tx) => {
              const changed = await tx.blockchainRecord.updateMany({ where: { id: record.id, status: "CONFIRMED" }, data: { status: "SUBMITTED", blockNumber: null, blockHash: null, confirmedAt: null, errorCode: "BLOCKCHAIN_REORG_DETECTED" } });
              if (changed.count !== 1) throw new Error(safeCode);
              await tx.outboxEvent.updateMany({ where: { eventType: "BLOCKCHAIN_ANCHOR", aggregateId: record.id, status: "PUBLISHED" }, data: { status: "PENDING", nextAttemptAt: now(), publishedAt: null, lastErrorCode: "BLOCKCHAIN_REORG_DETECTED" } });
            });
          }
          pending += 1;
        }
      } catch { pending += 1; }
    }
    return { checked: rows.length, confirmed, failed, pending };
  };

  return Object.freeze({ processOutboxBatch, reconcilePending });
};
