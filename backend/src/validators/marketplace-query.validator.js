import { z } from "zod";

const uuid = z.string().uuid();
const limit = z.string().regex(/^\d{1,3}$/).default("25").transform(Number).pipe(z.number().int().min(1).max(100));

export const sellerLookupQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
  cursor: uuid.optional(),
  limit,
}).strict();

const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const transactionStatuses = ["CREATED", "ACCEPTED", "AWAITING_PAYMENT", "FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED", "RELEASE_PENDING", "REFUND_PENDING", "COMPLETED", "REFUNDED", "CANCELLED", "REJECTED"];
const disputeStatuses = ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"];

export const adminTransactionListQuerySchema = z.object({
  cursor: uuid.optional(),
  limit,
  status: z.enum(transactionStatuses).optional(),
  buyerId: uuid.optional(),
  sellerId: uuid.optional(),
  createdFrom: dateTime.optional(),
  createdTo: dateTime.optional(),
}).strict().refine((value) => !value.createdFrom || !value.createdTo || value.createdFrom <= value.createdTo, { path: ["createdTo"] });

export const adminDisputeListQuerySchema = z.object({
  cursor: uuid.optional(),
  limit,
  status: z.enum(disputeStatuses).optional(),
}).strict();
