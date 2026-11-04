import { z } from "zod";
import { loginPasswordSchema, registrationPasswordSchema } from "./auth.validator.js";

const displayName = z.string().trim().min(1).max(120).nullable();
const locale = z.string().trim().min(2).max(16).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).transform((value) => {
  const [language, ...subtags] = value.split("-");
  return [language.toLowerCase(), ...subtags.map((part) => part.length === 2 ? part.toUpperCase() : part)].join("-");
});
const timeZone = z.string().trim().min(1).max(64).transform((value, context) => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { context.addIssue({ code: "custom" }); return z.NEVER; }
});

export const profileUpdateSchema = z.object({
  displayName: displayName.optional(),
  preferences: z.object({ locale: locale.optional(), timeZone: timeZone.optional() }).strict().optional(),
  notificationPreferences: z.object({ transactionUpdates: z.boolean().optional(), productUpdates: z.boolean().optional() }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const passwordChangeSchema = z.object({ currentPassword: loginPasswordSchema, newPassword: registrationPasswordSchema }).strict()
  .refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, { path: ["newPassword"] });

export const accountDeactivationSchema = z.object({ currentPassword: loginPasswordSchema, confirmation: z.literal("DEACTIVATE") }).strict();

export const adminUserStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]),
  reasonCode: z.enum(["POLICY_VIOLATION", "USER_REQUEST", "SECURITY_REVIEW", "OTHER"]),
}).strict();

export const adminUserListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.string().regex(/^\d{1,2}$/).default("25").transform(Number).pipe(z.number().int().min(1).max(100)),
  status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
}).strict();
