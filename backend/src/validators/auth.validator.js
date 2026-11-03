import { Buffer } from "node:buffer";
import { z } from "zod";

export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_UTF8_BYTES = 72;

const emailSchema = z
  .string({ error: "Email must be a string" })
  .trim()
  .max(320, { error: "Email must be no longer than 320 characters" })
  .email({ error: "Email must be a valid email address" })
  .transform((email) => email.toLowerCase());

const passwordStringSchema = z
  .string({ error: "Password must be a string" })
  .refine((password) => !/^\s*$/u.test(password), {
    error: "Password must not be empty or whitespace only",
  })
  .refine((password) => Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_UTF8_BYTES, {
    error: `Password must be no longer than ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`,
  });

export const registrationEmailSchema = emailSchema;
export const loginEmailSchema = emailSchema;
export const displayNameSchema = z
  .string({ error: "Display name must be a string" })
  .trim()
  .min(1, { error: "Display name must not be empty" })
  .max(120, { error: "Display name must be no longer than 120 characters" })
  .optional();

export const registrationPasswordSchema = passwordStringSchema.refine(
  (password) => Array.from(password).length >= PASSWORD_MIN_CODE_POINTS,
  { error: `Password must contain at least ${PASSWORD_MIN_CODE_POINTS} characters` },
);

// Login does not impose today's registration minimum so existing accounts can
// still authenticate if their password was created under an older policy.
export const loginPasswordSchema = passwordStringSchema.refine(
  (password) => password.length > 0,
  { error: "Password is required" },
);

export const registrationSchema = z
  .object({
    email: registrationEmailSchema,
    password: registrationPasswordSchema,
    displayName: displayNameSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: loginEmailSchema,
    password: loginPasswordSchema,
  })
  .strict();

const opaqueRefreshTokenSchema = z
  .string({ error: "Refresh token must be a string" })
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: "Refresh token is invalid" });

export const refreshSchema = z.object({ refreshToken: opaqueRefreshTokenSchema }).strict();
export const logoutSchema = refreshSchema;

export const mfaChallengeVerificationSchema = z.object({
  challengeToken: opaqueRefreshTokenSchema,
  code: z.string().regex(/^\d{6}$/),
}).strict();
