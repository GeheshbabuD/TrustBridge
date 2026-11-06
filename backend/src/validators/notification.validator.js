import { z } from "zod";

export const notificationListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.string().regex(/^\d{1,2}$/).default("25").transform(Number).pipe(z.number().int().min(1).max(100)),
}).strict();
export const notificationIdSchema = z.string().uuid();
