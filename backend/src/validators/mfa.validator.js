import { z } from "zod";

export const mfaEnrollmentSchema = z.object({}).strict();
export const mfaVerificationSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const legacyAdminEnrollmentStartSchema = z.object({ authorizationToken: z.string().min(32).max(512) }).strict();
export const legacyAdminEnrollmentVerifySchema = z.object({ authorizationToken: z.string().min(32).max(512), code: z.string().regex(/^\d{6}$/) }).strict();
export const legacyAdminRecoveryRequestSchema = z.object({ targetUserId: z.string().uuid() }).strict();
export const recoveryIdentityReferenceSchema = z.object({ evidenceReference: z.string().min(1).max(255) }).strict();
export const recoveryApprovalSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional() }).strict();
