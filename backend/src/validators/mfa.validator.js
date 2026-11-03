import { z } from "zod";

export const mfaEnrollmentSchema = z.object({}).strict();
export const mfaVerificationSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
