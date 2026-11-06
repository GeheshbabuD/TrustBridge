import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";

const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;

/** Domain-separated commitment for allowlisted status metadata only; never pass PII or evidence. */
export const hashTransactionStatusEvent = ({ transactionId, version, previousStatus, newStatus }) => {
  if (typeof transactionId !== "string" || !Number.isSafeInteger(version) || version < 1 || typeof newStatus !== "string") throw new TypeError("Invalid transaction status event");
  const canonical = stable({ domain: "trustbridge.transaction-status.v1", transactionId, version, previousStatus: previousStatus ?? null, newStatus });
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
};

export const hashBlockchainOperationKey = (value) => createHash("sha256").update(`trustbridge.operation.v1\0${value}`, "utf8").digest("hex");

/** Enqueue a status-history commitment in the same DB transaction. Only the event hash and opaque references leave PostgreSQL. */
export const enqueueBlockchainStatusCommitment = async (tx, event, config) => {
  // Application bootstrap validates environment before serving requests. Isolated domain tests
  // may intentionally omit the full environment; in that context the optional anchor stays off.
  if (config === undefined) {
    try { config = getEnv().integrations.blockchain; } catch { return null; }
  }
  if (!config.enabled) return null;
  if (!config.chainId || !config.contractAddress) throw new Error("Blockchain configuration is incomplete");
  const eventHash = hashTransactionStatusEvent(event);
  const idempotencyKey = `txstatus:${event.transactionId}:${event.version}`;
  const record = await tx.blockchainRecord.upsert({
    where: { transactionId_idempotencyKey: { transactionId: event.transactionId, idempotencyKey } },
    create: { transactionId: event.transactionId, network: String(config.chainId), contractReference: config.contractAddress, operationType: "TRANSACTION_STATUS_HISTORY", eventHash, idempotencyKey },
    update: {}, select: { id: true },
  });
  const eventKey = `CHAIN:${hashBlockchainOperationKey(`${config.chainId}:${config.contractAddress}:${idempotencyKey}`)}`;
  await tx.outboxEvent.upsert({
    where: { eventKey },
    create: { eventKey, eventType: "BLOCKCHAIN_ANCHOR", aggregateType: "BlockchainRecord", aggregateId: record.id, transactionId: event.transactionId, payload: { blockchainRecordId: record.id } },
    update: {},
  });
  return record.id;
};
