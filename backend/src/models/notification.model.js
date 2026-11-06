export const serializeNotification = (row) => ({
  id: row.id, type: row.type, title: row.title, message: row.message,
  readAt: row.readAt, createdAt: row.createdAt,
});

export const NOTIFICATION_TEMPLATES = Object.freeze({
  TRANSACTION_CREATED: Object.freeze({ type: "TRANSACTION_UPDATE", title: "Transaction invitation", message: "A transaction invitation is waiting for your response.", category: "transactionUpdates" }),
  TRANSACTION_STATUS_CHANGED: Object.freeze({ type: "TRANSACTION_UPDATE", title: "Transaction update", message: "A transaction status has changed.", category: "transactionUpdates" }),
  PAYMENT_STATUS_CHANGED: Object.freeze({ type: "PAYMENT_UPDATE", title: "Payment update", message: "A payment status has changed.", category: "transactionUpdates" }),
  ESCROW_OPERATION_AUTHORIZED: Object.freeze({ type: "ESCROW_UPDATE", title: "Escrow operation pending", message: "An escrow operation is awaiting processing.", category: "transactionUpdates" }),
  ESCROW_OPERATION_COMPLETED: Object.freeze({ type: "ESCROW_UPDATE", title: "Escrow operation update", message: "An escrow operation has a verified outcome.", category: "transactionUpdates" }),
  DISPUTE_OPENED: Object.freeze({ type: "DISPUTE_UPDATE", title: "Dispute opened", message: "A dispute has been opened for a transaction.", category: "transactionUpdates" }),
  DISPUTE_RESPONSE: Object.freeze({ type: "DISPUTE_UPDATE", title: "Dispute response", message: "A new response is available in a dispute.", category: "transactionUpdates" }),
  DISPUTE_RESOLVED: Object.freeze({ type: "DISPUTE_UPDATE", title: "Dispute reviewed", message: "A human reviewer recorded a dispute outcome.", category: "transactionUpdates" }),
});
