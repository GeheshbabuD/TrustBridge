import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_DIGITS = 6;
const DEFAULT_STEP_SECONDS = 30;

export class TotpInputError extends Error {
  constructor() {
    super("TOTP input is invalid");
    this.name = "TotpInputError";
  }
}

export const encodeBase32 = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TotpInputError();
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

export const decodeBase32 = (secret) => {
  if (typeof secret !== "string" || !/^[A-Z2-7]+=*$/i.test(secret)) throw new TotpInputError();
  const normalized = secret.toUpperCase().replace(/=+$/, "");
  if (!normalized || normalized.length % 8 === 1) throw new TotpInputError();
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new TotpInputError();
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (output.length < 10) throw new TotpInputError();
  return Buffer.from(output);
};

export const generateTotpSecret = ({ entropyBytes = 20, random = randomBytes } = {}) => {
  if (!Number.isInteger(entropyBytes) || entropyBytes < 20 || entropyBytes > 64 || typeof random !== "function") throw new TotpInputError();
  return encodeBase32(random(entropyBytes));
};

const validateParameters = ({ digits, stepSeconds }) => {
  if (!Number.isInteger(digits) || digits < 6 || digits > 8 || !Number.isInteger(stepSeconds) || stepSeconds < 1) throw new TotpInputError();
};

export const generateTotp = (secret, { at = new Date(), timeStep, digits = DEFAULT_DIGITS, stepSeconds = DEFAULT_STEP_SECONDS } = {}) => {
  validateParameters({ digits, stepSeconds });
  const key = decodeBase32(secret);
  const step = timeStep ?? Math.floor(at instanceof Date ? at.getTime() / 1000 / stepSeconds : Number.NaN);
  if (!Number.isSafeInteger(step) || step < 0) throw new TotpInputError();
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  const otp = String(binary % (10 ** digits)).padStart(digits, "0");
  return Object.freeze({ code: otp, timeStep: step });
};

export const verifyTotp = (secret, code, { at = new Date(), window = 1, digits = DEFAULT_DIGITS, stepSeconds = DEFAULT_STEP_SECONDS } = {}) => {
  validateParameters({ digits, stepSeconds });
  if (!Number.isInteger(window) || window < 0 || window > 2) throw new TotpInputError();
  if (typeof code !== "string" || !new RegExp(`^\\d{${digits}}$`).test(code) || !(at instanceof Date) || !Number.isFinite(at.getTime())) {
    return Object.freeze({ valid: false, timeStep: null });
  }
  let currentStep;
  try {
    decodeBase32(secret);
    currentStep = Math.floor(at.getTime() / 1000 / stepSeconds);
  } catch {
    return Object.freeze({ valid: false, timeStep: null });
  }
  if (!Number.isSafeInteger(currentStep) || currentStep < 0) return Object.freeze({ valid: false, timeStep: null });

  const offsets = [0, ...Array.from({ length: window }, (_, index) => [-(index + 1), index + 1]).flat()];
  const supplied = Buffer.from(code, "ascii");
  for (const offset of offsets) {
    const candidateStep = currentStep + offset;
    if (candidateStep < 0) continue;
    const expected = Buffer.from(generateTotp(secret, { timeStep: candidateStep, digits, stepSeconds }).code, "ascii");
    if (timingSafeEqual(supplied, expected)) return Object.freeze({ valid: true, timeStep: candidateStep });
  }
  return Object.freeze({ valid: false, timeStep: null });
};
