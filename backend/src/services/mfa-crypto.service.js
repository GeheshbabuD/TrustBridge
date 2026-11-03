import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";

const fail = () => new MfaCryptoError();
const aadFor = (userId, purpose) => Buffer.from(`trustbridge:mfa:${purpose}:${userId}`, "utf8");

export class MfaCryptoError extends Error {
  constructor() {
    super("MFA secret cryptographic operation failed");
    this.name = "MfaCryptoError";
    this.code = "MFA_CRYPTO_FAILED";
  }
}

// Provider contract: encryptSecret/decryptSecret execute authenticated
// encryption inside the provider and return/accept opaque versioned envelopes.
// Production KMS implementations can satisfy this contract without exporting
// key material into the application process.
export const createMfaCrypto = ({ provider } = {}) => {
  if (!provider || typeof provider.encryptSecret !== "function" || typeof provider.decryptSecret !== "function") {
    throw new TypeError("A complete MFA cryptographic provider is required");
  }

  return Object.freeze({
    async encrypt(secret, { userId, purpose = "totp" } = {}) {
      if (typeof secret !== "string" || !secret || typeof userId !== "string" || !userId) throw fail();
      try {
        const envelope = await provider.encryptSecret(secret, { userId, purpose, aad: aadFor(userId, purpose) });
        if (!Buffer.isBuffer(envelope?.ciphertext) || !Buffer.isBuffer(envelope?.nonce) || !Buffer.isBuffer(envelope?.authTag) || envelope.nonce.length !== 12 || envelope.authTag.length !== 16 || typeof envelope.keyId !== "string" || !envelope.keyId || !Number.isInteger(envelope.keyVersion) || envelope.keyVersion < 1) throw fail();
        return Object.freeze({ ...envelope });
      } catch { throw fail(); }
    },
    async decrypt(envelope, { userId, purpose = "totp" } = {}) {
      if (!envelope || typeof userId !== "string" || !userId) throw fail();
      try {
        const plaintext = await provider.decryptSecret(envelope, { userId, purpose, aad: aadFor(userId, purpose) });
        if (typeof plaintext !== "string" || !plaintext) throw fail();
        return plaintext;
      } catch { throw fail(); }
    },
  });
};

// This local adapter is deliberately not a KMS. Its key is allowed only in
// development/test, is never generated or defaulted here, and is rejected by
// environment validation in production.
export const createLocalDevelopmentEncryptionProvider = ({ environment = getEnv } = {}) => {
  const getKey = () => {
    const config = environment();
    if (config.nodeEnv === "production" || !config.mfa?.localEncryptionKey) throw fail();
    return config.mfa.localEncryptionKey;
  };

  return Object.freeze({
    async encryptSecret(plaintext, { userId, purpose, aad }) {
      try {
        const key = Buffer.from(getKey());
        if (key.length !== 32 || typeof plaintext !== "string" || !plaintext || !userId || !purpose) throw fail();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Object.freeze({ ciphertext, nonce, authTag: cipher.getAuthTag(), keyId: "local-development", keyVersion: 1 });
      } catch { throw fail(); }
    },
    async decryptSecret(envelope, { userId, purpose, aad }) {
      try {
        const key = Buffer.from(getKey());
        if (key.length !== 32 || envelope?.keyId !== "local-development" || envelope?.keyVersion !== 1 || !userId || !purpose || !Buffer.isBuffer(envelope?.ciphertext) || !Buffer.isBuffer(envelope?.nonce) || envelope.nonce.length !== 12 || !Buffer.isBuffer(envelope?.authTag) || envelope.authTag.length !== 16) throw fail();
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(envelope.authTag);
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
      } catch { throw fail(); }
    },
  });
};

export const createOpaqueSecret = () => randomBytes(32).toString("base64url");
