import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const disputeCreateSchema = z.object({
  category: z.enum(["NON_DELIVERY", "QUALITY", "SCOPE", "PAYMENT", "OTHER"]),
  description: z.string().trim().min(10).max(4000),
}).strict();
export const disputeResponseSchema = z.object({ message: z.string().trim().min(1).max(4000) }).strict();
export const evidenceCategorySchema = z.enum(["DELIVERY", "WORK_PROGRESS", "COMMUNICATION", "OTHER"]);
export const disputeResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("FULL_REFUND"), reason: z.string().trim().min(10).max(2000) }).strict(),
  z.object({ outcome: z.literal("PARTIAL_REFUND"), amountMinor: z.string().regex(/^[1-9]\d{0,17}$/), reason: z.string().trim().min(10).max(2000) }).strict(),
  z.object({ outcome: z.literal("SELLER_RELEASE"), reason: z.string().trim().min(10).max(2000) }).strict(),
]);
export const disputeIdSchema = uuid;
export const disputeParamsSchema = z.object({ disputeId: disputeIdSchema }).strict();
export const transactionIdSchema = uuid;
export const disputeIdempotencyKeySchema = idempotencyKey;
