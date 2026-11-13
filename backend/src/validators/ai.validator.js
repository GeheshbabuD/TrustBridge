import { z } from "zod";

export const emptyRequestBodySchema = z.object({}).strict();

const count = z.number().int().min(0).max(1000000);
export const transactionRiskInputSchema = z.object({
  inputDataVersion: z.literal("transaction-risk.v1"),
  transaction: z.object({
    status: z.enum(["CREATED", "ACCEPTED", "AWAITING_PAYMENT", "FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED", "RELEASE_PENDING", "REFUND_PENDING", "COMPLETED", "CANCELLED", "REJECTED", "REFUNDED"]),
    amountMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    ageDays: z.number().int().min(0).max(36500),
    version: z.number().int().positive(),
  }).strict(),
  paymentAttempts: z.object({ created: count, pending: count, captured: count, failed: count, cancelled: count }).strict(),
  disputes: z.object({ open: count, underReview: count, resolved: count, closed: count }).strict(),
}).strict();

const safeText = z.string().trim().min(1).max(600).refine((value) =>
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
  && !/\b(?:bearer\s+|api[_ -]?key|password|secret|access[_ -]?token|refresh[_ -]?token)\b/i.test(value)
  && !/https?:\/\//i.test(value));
const riskIndicatorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  explanation: safeText,
}).strict();

export const transactionRiskResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  indicators: z.array(riskIndicatorSchema).max(12),
  confidenceLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  recommendation: z.enum(["NONE", "MANUAL_REVIEW", "REQUEST_MORE_INFORMATION"]),
  summary: safeText,
}).strict();

export const transactionRiskAssessmentParamsSchema = z.object({ transactionId: z.string().uuid() }).strict();

const disputeCategory = z.enum(["NON_DELIVERY", "QUALITY", "SCOPE", "PAYMENT", "OTHER"]);
const evidenceCategory = z.enum(["DELIVERY", "WORK_PROGRESS", "COMMUNICATION", "OTHER"]);
const disputeStatus = z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"]);
const disputeText = z.string().trim().min(1).max(4000).refine((value) =>
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
  && !/https?:\/\//i.test(value)
  && !/\b(?:bearer\s+|api[_ -]?key|password|secret|access[_ -]?token|refresh[_ -]?token)\b/i.test(value)
  && !/(?<!\w)\+?\d[\d .()\-]{7,}\d(?!\w)/.test(value));

export const disputeAssistanceInputSchema = z.object({
  inputDataVersion: z.literal("dispute-assistance.v1"),
  dispute: z.object({ category: disputeCategory, status: disputeStatus, description: disputeText, ageDays: z.number().int().min(0).max(36500), version: z.number().int().positive() }).strict(),
  evidenceCounts: z.object({ DELIVERY: count, WORK_PROGRESS: count, COMMUNICATION: count, OTHER: count }).strict(),
}).strict();

const safeDisputeOutputText = z.string().trim().min(1).max(1200).refine((value) =>
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
  && !/https?:\/\//i.test(value)
  && !/\b(?:bearer\s+|api[_ -]?key|password|secret|access[_ -]?token|refresh[_ -]?token)\b/i.test(value)
  && !/(?<!\w)\+?\d[\d .()\-]{7,}\d(?!\w)/.test(value));

export const disputeAssistanceResultSchema = z.object({
  summary: safeDisputeOutputText,
  suggestedCategory: disputeCategory,
  missingEvidenceCategories: z.array(evidenceCategory).max(4).refine((values) => new Set(values).size === values.length),
  reviewSteps: z.array(z.enum(["COMPARE_AGREED_TERMS", "REVIEW_PARTICIPANT_RESPONSES", "REQUEST_EVIDENCE", "VERIFY_EVIDENCE_METADATA", "HUMAN_RESOLUTION_REQUIRED"])).min(1).max(5).refine((values) => new Set(values).size === values.length),
  advisoryOnly: z.literal(true),
}).strict();

export const disputeAssistanceParamsSchema = z.object({ disputeId: z.string().uuid() }).strict();
