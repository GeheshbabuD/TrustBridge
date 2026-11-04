import { config as loadDotEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Anchor local development configuration to this backend package, not to the
// caller's current working directory (which may differ for Prisma CLI runs).
const backendEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

const secretSchema = z
  .string()
  .trim()
  .min(32)
  .refine((value) => new Set(value).size >= 8)
  .refine((value) => !/(replace|placeholder|example|change[-_ ]?me)/i.test(value));

const identifierSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

const optionalNonEmptyString = z.string().trim().min(1).optional();

const durationSeconds = (value) => {
  const match = /^([1-9]\d{0,3})(s|m|h|d|w)$/.exec(value);
  if (!match) return Number.POSITIVE_INFINITY;

  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Number(match[1]) * unitSeconds[match[2]];
};

const accessTtlSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,3}(?:s|m|h|d)$/)
  .refine((value) => durationSeconds(value) <= 86400);

const refreshTtlSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,3}(?:h|d|w)$/)
  .refine((value) => durationSeconds(value) <= 90 * 86400);

const booleanEnvSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(["true", "false"]))
  .default("false")
  .transform((value) => value === "true");

const postgresUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

const localMfaKeySchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => Buffer.from(value, "base64").length === 32);

const corsOriginsSchema = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
  .superRefine((origins, context) => {
    origins.forEach((origin, index) => {
      try {
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
          context.addIssue({ code: "custom", path: [index] });
        }
      } catch {
        context.addIssue({ code: "custom", path: [index] });
      }
    });
  });

const rpcUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      return ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z
      .string()
      .regex(/^\d+$/)
      .default("3000")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    CORS_ALLOWED_ORIGINS: corsOriginsSchema,
    API_RATE_LIMIT_WINDOW_MS: z
      .string()
      .regex(/^\d+$/)
      .default("900000")
      .transform(Number)
      .pipe(z.number().int().min(1000).max(86400000)),
    API_RATE_LIMIT_MAX: z
      .string()
      .regex(/^\d+$/)
      .default("100")
      .transform(Number)
      .pipe(z.number().int().min(1).max(10000)),
    RATE_LIMIT_STORE: z.enum(["memory", "redis"]).default("memory"),
    REDIS_URL: z.string().trim().url().refine((value) => {
      try { return ["redis:", "rediss:"].includes(new URL(value).protocol); } catch { return false; }
    }).optional(),
    RATE_LIMIT_KEY_SECRET: secretSchema.optional(),
    BCRYPT_SALT_ROUNDS: z
      .string()
      .regex(/^\d+$/)
      .default("12")
      .transform(Number)
      .pipe(z.number().int().min(12).max(15)),
    DATABASE_URL: postgresUrlSchema,

    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_TTL: accessTtlSchema.default("15m"),
    JWT_REFRESH_TTL: refreshTtlSchema.default("7d"),
    JWT_ALGORITHM: z.literal("HS256").default("HS256"),
    JWT_ISSUER: z.string().trim().min(1).default("trustbridge-api"),
    JWT_AUDIENCE: z.string().trim().min(1).default("trustbridge-client"),
    MFA_LOCAL_ENCRYPTION_KEY: localMfaKeySchema.optional(),
    MFA_ENCRYPTION_PROVIDER: z.enum(["local", "kms"]).default("local"),
    MFA_KMS_KEY_ID: z.string().trim().min(1).max(128).optional(),
    MFA_KMS_KEY_VERSION: z.string().regex(/^[1-9]\d{0,8}$/).transform(Number).pipe(z.number().int().positive()).optional(),
    MFA_TOTP_WINDOW_STEPS: z.string().regex(/^\d+$/).default("1").transform(Number).pipe(z.number().int().min(0).max(2)),
    MFA_VERIFY_RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).default("600000").transform(Number).pipe(z.number().int().min(1000).max(3600000)),
    MFA_VERIFY_RATE_LIMIT_MAX: z.string().regex(/^\d+$/).default("5").transform(Number).pipe(z.number().int().min(1).max(20)),
    AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).default("900000").transform(Number).pipe(z.number().int().min(1000).max(3600000)),
    AUTH_LOGIN_RATE_LIMIT_MAX: z.string().regex(/^\d+$/).default("10").transform(Number).pipe(z.number().int().min(1).max(100)),
    MFA_CHALLENGE_RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).default("600000").transform(Number).pipe(z.number().int().min(1000).max(3600000)),
    MFA_CHALLENGE_RATE_LIMIT_MAX: z.string().regex(/^\d+$/).default("5").transform(Number).pipe(z.number().int().min(1).max(50)),
    MFA_LOGIN_CHALLENGE_TTL_SECONDS: z.string().regex(/^\d+$/).default("300").transform(Number).pipe(z.number().int().min(60).max(900)),
    MFA_STEP_UP_CHALLENGE_TTL_SECONDS: z.string().regex(/^\d+$/).default("300").transform(Number).pipe(z.number().int().min(60).max(600)),
    MFA_ASSURANCE_MAX_AGE_SECONDS: z.string().regex(/^\d+$/).default("900").transform(Number).pipe(z.number().int().min(60).max(3600)),

    AI_ENABLED: booleanEnvSchema,
    AI_PROVIDER: identifierSchema.optional(),
    AI_API_KEY: optionalNonEmptyString,

    BLOCKCHAIN_ENABLED: booleanEnvSchema,
    BLOCKCHAIN_RPC_URL: rpcUrlSchema.optional(),
    BLOCKCHAIN_CONTRACT_ADDRESS: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    BLOCKCHAIN_CHAIN_ID: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive().safe())
      .optional(),

    PAYMENT_ENABLED: booleanEnvSchema,
    PAYMENT_PROVIDER: identifierSchema.optional(),
    PAYMENT_API_KEY: optionalNonEmptyString,
    PAYMENT_API_SECRET: optionalNonEmptyString,
    PAYMENT_WEBHOOK_SECRET: z.string().trim().min(16).optional(),
  })
  .superRefine((config, context) => {
    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["JWT_REFRESH_SECRET"],
      });
    }

    if (config.NODE_ENV === "production" && config.MFA_LOCAL_ENCRYPTION_KEY) {
      context.addIssue({ code: "custom", path: ["MFA_LOCAL_ENCRYPTION_KEY"] });
    }
    if (config.NODE_ENV === "production") {
      if (config.MFA_ENCRYPTION_PROVIDER !== "kms") context.addIssue({ code: "custom", path: ["MFA_ENCRYPTION_PROVIDER"] });
      if (!config.MFA_KMS_KEY_ID) context.addIssue({ code: "custom", path: ["MFA_KMS_KEY_ID"] });
      if (!config.MFA_KMS_KEY_VERSION) context.addIssue({ code: "custom", path: ["MFA_KMS_KEY_VERSION"] });
    }
    if (config.MFA_ENCRYPTION_PROVIDER === "kms" && (!config.MFA_KMS_KEY_ID || !config.MFA_KMS_KEY_VERSION)) {
      if (!config.MFA_KMS_KEY_ID) context.addIssue({ code: "custom", path: ["MFA_KMS_KEY_ID"] });
      if (!config.MFA_KMS_KEY_VERSION) context.addIssue({ code: "custom", path: ["MFA_KMS_KEY_VERSION"] });
    }

    if (config.NODE_ENV === "production") {
      if (config.RATE_LIMIT_STORE !== "redis") context.addIssue({ code: "custom", path: ["RATE_LIMIT_STORE"] });
      if (!config.REDIS_URL) context.addIssue({ code: "custom", path: ["REDIS_URL"] });
      else {
        const redisUrl = new URL(config.REDIS_URL);
        if (redisUrl.protocol !== "rediss:" || !redisUrl.username || !redisUrl.password) {
          context.addIssue({ code: "custom", path: ["REDIS_URL"] });
        }
      }
      if (!config.RATE_LIMIT_KEY_SECRET) context.addIssue({ code: "custom", path: ["RATE_LIMIT_KEY_SECRET"] });
      if (config.RATE_LIMIT_KEY_SECRET && [config.JWT_ACCESS_SECRET, config.JWT_REFRESH_SECRET].includes(config.RATE_LIMIT_KEY_SECRET)) {
        context.addIssue({ code: "custom", path: ["RATE_LIMIT_KEY_SECRET"] });
      }
    }
    if (config.RATE_LIMIT_STORE === "redis" && !config.REDIS_URL) {
      context.addIssue({ code: "custom", path: ["REDIS_URL"] });
    }

    if (config.AI_ENABLED) {
      if (!config.AI_PROVIDER) {
        context.addIssue({ code: "custom", path: ["AI_PROVIDER"] });
      }
      if (!config.AI_API_KEY) {
        context.addIssue({ code: "custom", path: ["AI_API_KEY"] });
      }
    }

    if (config.BLOCKCHAIN_ENABLED) {
      if (!config.BLOCKCHAIN_RPC_URL) {
        context.addIssue({ code: "custom", path: ["BLOCKCHAIN_RPC_URL"] });
      }
      if (!config.BLOCKCHAIN_CONTRACT_ADDRESS) {
        context.addIssue({ code: "custom", path: ["BLOCKCHAIN_CONTRACT_ADDRESS"] });
      }
    }

    if (config.PAYMENT_ENABLED) {
      if (!config.PAYMENT_PROVIDER) {
        context.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"] });
      }
      if (!config.PAYMENT_API_KEY) {
        context.addIssue({ code: "custom", path: ["PAYMENT_API_KEY"] });
      }
      if (!config.PAYMENT_API_SECRET) {
        context.addIssue({ code: "custom", path: ["PAYMENT_API_SECRET"] });
      }
      if (!config.PAYMENT_WEBHOOK_SECRET) {
        context.addIssue({ code: "custom", path: ["PAYMENT_WEBHOOK_SECRET"] });
      }
    }
  });

const safeFieldMessages = Object.freeze({
  NODE_ENV: "must be development, test, or production",
  PORT: "must be an integer from 1 through 65535",
  CORS_ALLOWED_ORIGINS: "must be a comma-separated list of exact HTTP(S) origins without paths or wildcards",
  API_RATE_LIMIT_WINDOW_MS: "must be an integer from 1000 through 86400000 milliseconds",
  API_RATE_LIMIT_MAX: "must be an integer from 1 through 10000 requests",
  RATE_LIMIT_STORE: "must be memory in development/test or redis in production",
  REDIS_URL: "must be a valid Redis URL; production requires rediss with ACL username and password",
  RATE_LIMIT_KEY_SECRET: "must be a distinct, non-placeholder secret of at least 32 characters and is required in production",
  BCRYPT_SALT_ROUNDS: "must be an integer from 12 through 15",
  DATABASE_URL: "must be a valid PostgreSQL URL",
  JWT_ACCESS_SECRET: "must be a distinct, non-placeholder secret of at least 32 characters",
  JWT_REFRESH_SECRET: "must be a distinct, non-placeholder secret of at least 32 characters",
  JWT_ACCESS_TTL: "must be a JWT duration no longer than 24 hours",
  JWT_REFRESH_TTL: "must be a JWT duration no longer than 90 days",
  JWT_ALGORITHM: "must be HS256",
  JWT_ISSUER: "must be non-empty",
  JWT_AUDIENCE: "must be non-empty",
  MFA_LOCAL_ENCRYPTION_KEY: "must be a base64-encoded 32-byte local development/test key and is forbidden in production",
  MFA_ENCRYPTION_PROVIDER: "must be local in development/test or kms in production",
  MFA_KMS_KEY_ID: "must identify the configured KMS key",
  MFA_KMS_KEY_VERSION: "must be a positive integer key-envelope version",
  MFA_TOTP_WINDOW_STEPS: "must be an integer from 0 through 2 time steps",
  MFA_VERIFY_RATE_LIMIT_WINDOW_MS: "must be an integer from 1000 through 3600000 milliseconds",
  MFA_VERIFY_RATE_LIMIT_MAX: "must be an integer from 1 through 20 failed attempts",
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: "must be an integer from 1000 through 3600000 milliseconds",
  AUTH_LOGIN_RATE_LIMIT_MAX: "must be an integer from 1 through 100 attempts",
  MFA_CHALLENGE_RATE_LIMIT_WINDOW_MS: "must be an integer from 1000 through 3600000 milliseconds",
  MFA_CHALLENGE_RATE_LIMIT_MAX: "must be an integer from 1 through 50 attempts",
  MFA_LOGIN_CHALLENGE_TTL_SECONDS: "must be an integer from 60 through 900 seconds",
  MFA_STEP_UP_CHALLENGE_TTL_SECONDS: "must be an integer from 60 through 600 seconds",
  MFA_ASSURANCE_MAX_AGE_SECONDS: "must be an integer from 60 through 3600 seconds",
  AI_ENABLED: "must be true or false",
  AI_PROVIDER: "must be a valid provider identifier and is required when AI_ENABLED=true",
  AI_API_KEY: "must be non-empty and is required when AI_ENABLED=true",
  BLOCKCHAIN_ENABLED: "must be true or false",
  BLOCKCHAIN_RPC_URL: "must use HTTP(S) or WS(S) and is required when BLOCKCHAIN_ENABLED=true",
  BLOCKCHAIN_CONTRACT_ADDRESS: "must be a 20-byte EVM address and is required when BLOCKCHAIN_ENABLED=true",
  BLOCKCHAIN_CHAIN_ID: "must be a positive safe integer",
  PAYMENT_ENABLED: "must be true or false",
  PAYMENT_PROVIDER: "must be a valid provider identifier and is required when PAYMENT_ENABLED=true",
  PAYMENT_API_KEY: "must be non-empty and is required when PAYMENT_ENABLED=true",
  PAYMENT_API_SECRET: "must be non-empty and is required when PAYMENT_ENABLED=true",
  PAYMENT_WEBHOOK_SECRET: "must be at least 16 characters and is required when PAYMENT_ENABLED=true",
});

export class EnvironmentConfigError extends Error {
  constructor(issues) {
    const safeMessages = new Map();

    for (const issue of issues) {
      const field = issue.path[0];
      if (typeof field === "string") {
        safeMessages.set(
          field,
          `${field} ${safeFieldMessages[field] ?? "has an invalid value"}`,
        );
      }
    }

    super(`Invalid environment configuration:\n${[...safeMessages.values()]
      .map((message) => `- ${message}`)
      .join("\n")}`);
    this.name = "EnvironmentConfigError";
  }
}

// Prisma CLI needs only the database URL; it must not depend on application JWT secrets.
export const getDatabaseUrl = (source) => {
  const environment = source ?? readRuntimeEnvironment();
  const result = postgresUrlSchema.safeParse(environment.DATABASE_URL);
  if (!result.success) {
    throw new EnvironmentConfigError([{ path: ["DATABASE_URL"] }]);
  }

  return result.data;
};

const defineSecret = (target, key, value) => {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
};

const readRuntimeEnvironment = () => {
  // Load local development settings on demand; host-provided values take precedence.
  loadDotEnv({ path: backendEnvPath, quiet: true });
  return process.env;
};

const makeConfig = (values) => {
  const database = {};
  defineSecret(database, "url", values.DATABASE_URL);

  const rateLimit = {
    windowMs: values.API_RATE_LIMIT_WINDOW_MS,
    max: values.API_RATE_LIMIT_MAX,
    store: values.RATE_LIMIT_STORE,
  };
  defineSecret(rateLimit, "keySecret", values.RATE_LIMIT_KEY_SECRET ?? values.JWT_ACCESS_SECRET);
  defineSecret(rateLimit, "redisUrl", values.REDIS_URL);

  const jwt = {
    accessTtl: values.JWT_ACCESS_TTL,
    refreshTtl: values.JWT_REFRESH_TTL,
    algorithm: values.JWT_ALGORITHM,
    issuer: values.JWT_ISSUER,
    audience: values.JWT_AUDIENCE,
  };
  defineSecret(jwt, "accessSecret", values.JWT_ACCESS_SECRET);
  defineSecret(jwt, "refreshSecret", values.JWT_REFRESH_SECRET);

  const mfa = {
    encryptionProvider: values.MFA_ENCRYPTION_PROVIDER,
    kmsKeyId: values.MFA_KMS_KEY_ID,
    kmsKeyVersion: values.MFA_KMS_KEY_VERSION,
    localKeyConfigured: Boolean(values.MFA_LOCAL_ENCRYPTION_KEY),
    totpWindowSteps: values.MFA_TOTP_WINDOW_STEPS,
    verificationRateLimit: Object.freeze({ windowMs: values.MFA_VERIFY_RATE_LIMIT_WINDOW_MS, max: values.MFA_VERIFY_RATE_LIMIT_MAX }),
    loginChallengeTtlSeconds: values.MFA_LOGIN_CHALLENGE_TTL_SECONDS,
    stepUpChallengeTtlSeconds: values.MFA_STEP_UP_CHALLENGE_TTL_SECONDS,
    assuranceMaxAgeSeconds: values.MFA_ASSURANCE_MAX_AGE_SECONDS,
    challengeRateLimit: Object.freeze({ windowMs: values.MFA_CHALLENGE_RATE_LIMIT_WINDOW_MS, max: values.MFA_CHALLENGE_RATE_LIMIT_MAX }),
    loginRateLimit: Object.freeze({ windowMs: values.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS, max: values.AUTH_LOGIN_RATE_LIMIT_MAX }),
  };
  if (values.MFA_LOCAL_ENCRYPTION_KEY) {
    defineSecret(mfa, "localEncryptionKey", Buffer.from(values.MFA_LOCAL_ENCRYPTION_KEY, "base64"));
  }

  const ai = { enabled: values.AI_ENABLED, provider: values.AI_PROVIDER };
  defineSecret(ai, "apiKey", values.AI_API_KEY);

  const blockchain = {
    enabled: values.BLOCKCHAIN_ENABLED,
    contractAddress: values.BLOCKCHAIN_CONTRACT_ADDRESS,
    chainId: values.BLOCKCHAIN_CHAIN_ID,
  };
  defineSecret(blockchain, "rpcUrl", values.BLOCKCHAIN_RPC_URL);

  const payment = {
    enabled: values.PAYMENT_ENABLED,
    provider: values.PAYMENT_PROVIDER,
  };
  defineSecret(payment, "apiKey", values.PAYMENT_API_KEY);
  defineSecret(payment, "apiSecret", values.PAYMENT_API_SECRET);
  defineSecret(payment, "webhookSecret", values.PAYMENT_WEBHOOK_SECRET);

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    corsAllowedOrigins: Object.freeze(values.CORS_ALLOWED_ORIGINS),
    rateLimit: Object.freeze(rateLimit),
    password: Object.freeze({ bcryptSaltRounds: values.BCRYPT_SALT_ROUNDS }),
    database: Object.freeze(database),
    jwt: Object.freeze(jwt),
    mfa: Object.freeze(mfa),
    integrations: Object.freeze({
      ai: Object.freeze(ai),
      blockchain: Object.freeze(blockchain),
      payment: Object.freeze(payment),
    }),
  });
};

export const validateEnv = (source) => {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentConfigError(result.error.issues);
  }

  return makeConfig(result.data);
};

let cachedEnv;

// Call once during application startup and pass this validated object to services.
export const getEnv = () => {
  if (!cachedEnv) {
    cachedEnv = validateEnv(readRuntimeEnvironment());
  }

  return cachedEnv;
};
