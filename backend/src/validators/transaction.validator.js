import { z } from "zod";
import { TRANSACTION_STATUS_VALUES } from "../models/transaction.model.js";

const terms = z.object({
  description: z.string().trim().min(1).max(2000),
  scope: z.string().trim().min(1).max(5000).optional(),
  delivery: z.object({
    description: z.string().trim().min(1).max(2000).optional(),
    expectedBy: z.string().datetime({ offset: true }).optional(),
    days: z.number().int().positive().max(3650).optional(),
  }).strict().optional(),
  milestones: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000),
    dueAt: z.string().datetime({ offset: true }).optional(),
  }).strict()).max(20).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  cancellationPolicyRef: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
  disputePolicyRef: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
}).strict().superRefine((value, context) => {
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (depth > 8 || nodes > 1000) return false;
    if (Array.isArray(item)) return item.every((entry) => visit(entry, depth + 1));
    if (item && typeof item === "object") return Object.entries(item).every(([key, entry]) => key.length <= 128 && visit(entry, depth + 1));
    return true;
  };
  let encoded;
  try { encoded = JSON.stringify(value); } catch { encoded = null; }
  if (!visit(value, 0) || !encoded || Buffer.byteLength(encoded, "utf8") > 32768) context.addIssue({ code: "custom" });
});

const positiveMinorUnits = z.string().regex(/^[1-9]\d{0,18}$/).refine((value) => BigInt(value) <= 9223372036854775807n);
const currencyCode = z.string().regex(/^[A-Z]{3}$/).refine((value) => Intl.supportedValuesOf("currency").includes(value));

export const transactionCreateSchema = z.object({
  sellerId: z.string().uuid(),
  amountMinor: positiveMinorUnits,
  currency: currencyCode,
  terms,
}).strict();

export const transactionTermsProposalSchema = z.object({
  amountMinor: positiveMinorUnits,
  currency: currencyCode,
  terms,
}).strict();

export const transactionTermsDecisionSchema = z.object({
  version: z.number().int().positive().max(2147483647),
  decision: z.enum(["ACCEPTED", "REJECTED"]),
}).strict();

export const transactionInvitationCreateSchema = z.object({ inviteeId: z.string().uuid() }).strict();
export const transactionInvitationResponseSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expectedVersion: z.number().int().positive().max(2147483647),
}).strict();

export const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const transactionListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.string().regex(/^\d{1,2}$/).default("25").transform(Number).pipe(z.number().int().min(1).max(100)),
  status: z.enum(TRANSACTION_STATUS_VALUES).optional(),
}).strict();

export const transactionTransitionSchema = z.object({
  status: z.enum(TRANSACTION_STATUS_VALUES),
  expectedVersion: z.number().int().positive().max(2147483647),
}).strict();

export const transactionHistoryQuerySchema = z.object({
  cursor: z.string().regex(/^[1-9]\d{0,9}$/).refine((value) => Number(value) <= 2147483647).optional(),
  limit: z.string().regex(/^\d{1,2}$/).default("25").transform(Number).pipe(z.number().int().min(1).max(100)),
}).strict();
