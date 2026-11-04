import { z } from "zod";

export const escrowOperationSchema = z.object({ reasonCode: z.enum(["BUYER_ACCEPTED_DELIVERY", "ADMIN_RESOLVED_REFUND"]) }).strict();
export const escrowTransactionIdSchema = z.string().uuid();
export const escrowIdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
