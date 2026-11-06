import { createHash } from "node:crypto";
import { NOTIFICATION_TEMPLATES } from "../models/notification.model.js";

/** Enqueue one minimal, deduplicated notification event for each persisted transaction participant. */
export const enqueueTransactionNotice = async (tx, { transactionId, template, discriminator }) => {
  if (!Object.hasOwn(NOTIFICATION_TEMPLATES, template)) throw new TypeError("Unknown notification template");
  const transaction = await tx.transaction.findUnique({ where: { id: transactionId }, select: { id: true, buyerId: true, sellerId: true } });
  if (!transaction || typeof transaction.buyerId !== "string" || typeof transaction.sellerId !== "string") return;
  const eventType = "USER_NOTIFICATION";
  for (const recipientId of new Set([transaction.buyerId, transaction.sellerId])) {
    const eventKey = `NOTICE:${createHash("sha256").update(`${template}\0${transactionId}\0${discriminator}\0${recipientId}`).digest("hex")}`;
    await tx.outboxEvent.create({ data: {
      eventKey, eventType, aggregateType: "Transaction", aggregateId: transactionId, transactionId,
      payload: { recipientId, template, resourceType: "TRANSACTION", resourceId: transactionId },
    } });
  }
};
