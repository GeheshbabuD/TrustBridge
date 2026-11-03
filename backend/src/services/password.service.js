import { Buffer } from "node:buffer";
import bcrypt from "bcrypt";
import { getEnv } from "../config/env.js";
import {
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_MIN_CODE_POINTS,
} from "../validators/auth.validator.js";

const BCRYPT_MIN_SALT_ROUNDS = 12;
const BCRYPT_MAX_SALT_ROUNDS = 15;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export class PasswordInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PasswordInputError";
  }
}

const validatePasswordString = (password, { requireRegistrationMinimum = false } = {}) => {
  if (typeof password !== "string") {
    throw new PasswordInputError("Password must be a string");
  }

  if (/^\s*$/u.test(password)) {
    throw new PasswordInputError("Password must not be empty or whitespace only");
  }

  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_UTF8_BYTES) {
    throw new PasswordInputError(`Password must be no longer than ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`);
  }

  if (requireRegistrationMinimum && Array.from(password).length < PASSWORD_MIN_CODE_POINTS) {
    throw new PasswordInputError(`Password must contain at least ${PASSWORD_MIN_CODE_POINTS} characters`);
  }
};

const validateSaltRounds = (saltRounds) => {
  if (
    !Number.isInteger(saltRounds) ||
    saltRounds < BCRYPT_MIN_SALT_ROUNDS ||
    saltRounds > BCRYPT_MAX_SALT_ROUNDS
  ) {
    throw new PasswordInputError("Bcrypt work factor must be an integer from 12 through 15");
  }
};

/** Hash a registration password asynchronously using the configured bcrypt work factor. */
export const hashPassword = async (password, options = {}) => {
  validatePasswordString(password, { requireRegistrationMinimum: true });
  const saltRounds = options.saltRounds ?? getEnv().password.bcryptSaltRounds;
  validateSaltRounds(saltRounds);

  try {
    return await bcrypt.hash(password, saltRounds);
  } catch {
    throw new Error("Password hashing failed");
  }
};

/** Verify a plaintext password. Invalid/malformed hashes safely return false. */
export const verifyPassword = async (password, hash) => {
  validatePasswordString(password);

  if (typeof hash !== "string") return false;
  const match = BCRYPT_HASH_PATTERN.exec(hash);
  if (!match || Number(match[1]) < 4 || Number(match[1]) > 31) return false;

  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
};
