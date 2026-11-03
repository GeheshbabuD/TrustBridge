import { z } from "zod";

export const stepUpChallengeSchema = z.object({
  purpose: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  resourceId: z.string().uuid().optional(),
}).strict();

export const stepUpVerificationSchema = z.object({
  challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^\d{6}$/),
}).strict();
