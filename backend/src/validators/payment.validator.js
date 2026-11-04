import { z } from "zod";

export const paymentIdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const webhookProviderSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
export const paymentAttemptIdSchema = z.string().uuid();
const providerIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
export const paymentCallbackSchema = z.object({ orderId: providerIdSchema, paymentId: providerIdSchema, signature: z.string().regex(/^[0-9a-f]{64}$/i) }).strict();
