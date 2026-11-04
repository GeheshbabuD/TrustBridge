export const TRANSACTION_STATUS_VALUES = Object.freeze([
  "CREATED", "ACCEPTED", "AWAITING_PAYMENT", "FUNDED", "IN_PROGRESS", "DELIVERED",
  "DISPUTED", "RELEASE_PENDING", "REFUND_PENDING", "COMPLETED", "REFUNDED", "CANCELLED", "REJECTED",
]);

// TB-BE-037 owns participant initiation/acceptance. Payment, dispute resolution,
// payout and refund transitions remain gated by their dedicated later modules.
export const PARTICIPANT_TRANSITIONS = Object.freeze({
  CREATED: Object.freeze({
    ACCEPTED: Object.freeze({ role: "SELLER", reasonCode: "SELLER_ACCEPTED" }),
    CANCELLED: Object.freeze({ role: "BUYER", reasonCode: "BUYER_CANCELLED" }),
  }),
  ACCEPTED: Object.freeze({
    AWAITING_PAYMENT: Object.freeze({ role: "BUYER", reasonCode: "PAYMENT_REQUESTED" }),
  }),
  AWAITING_PAYMENT: Object.freeze({
    CANCELLED: Object.freeze({ role: "BUYER", reasonCode: "BUYER_CANCELLED" }),
  }),
});

export const serializeTransaction = (transaction) => ({
  id: transaction.id,
  buyerId: transaction.buyerId,
  sellerId: transaction.sellerId,
  status: transaction.status,
  amountMinor: transaction.amountMinor.toString(),
  currency: transaction.currency.trim(),
  terms: transaction.terms,
  version: transaction.version,
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt,
  ...(transaction.participants ? { participants: transaction.participants.map(({ userId, role, joinedAt }) => ({ userId, role, joinedAt })) } : {}),
});

export const serializeStatusHistory = (row) => ({
  version: row.version,
  previousStatus: row.previousStatus,
  newStatus: row.newStatus,
  actorUserId: row.actorUserId,
  reason: row.reason,
  createdAt: row.createdAt,
});

export const serializeTermsVersion = (row) => ({
  id: row.id,
  version: row.version,
  proposedById: row.proposedById,
  amountMinor: row.amountMinor.toString(),
  currency: row.currency.trim(),
  terms: row.details,
  status: row.status,
  createdAt: row.createdAt,
  decisions: (row.decisions ?? []).map(({ actorUserId, decision, createdAt }) => ({ actorUserId, decision, createdAt })),
});
