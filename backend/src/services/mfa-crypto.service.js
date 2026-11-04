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
    async checkAvailability() {
      try {
        if (typeof provider.checkAvailability === "function") await provider.checkAvailability();
        else if (provider.kind !== "local-development") throw fail();
        return true;
      } catch { throw fail(); }
    },
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
    kind: "local-development",
    async checkAvailability() {
      try { return getKey().length === 32; } catch { throw fail(); }
    },
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

const ENVELOPE_MAGIC = Buffer.from("TBK1");
const kmsAad = (aad, keyId, keyVersion) => Buffer.concat([aad, Buffer.from(`\u0000${keyId}\u0000${keyVersion}`, "utf8")]);

// Provider-neutral envelope encryption. The injected KMS client must implement
// generateDataKey({ keyId, encryptionContext }) and
// decryptDataKey({ keyId, keyVersion, encryptedDataKey, encryptionContext }).
// Plaintext DEKs exist only for the duration of one operation; the KEK never
// enters this process. The database ciphertext packs the wrapped DEK alongside
// the AES-GCM ciphertext, so no schema field is needed.
export const createKmsEnvelopeEncryptionProvider = ({ kms, keyId, keyVersion } = {}) => {
  if (!kms || typeof kms.generateDataKey !== "function" || typeof kms.decryptDataKey !== "function" || typeof kms.checkAvailability !== "function"
    || typeof keyId !== "string" || !keyId || keyId.trim() !== keyId || keyId.length > 128 || !Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError("A configured KMS client and key version are required");
  }

  const encryptionContext = (purpose) => Object.freeze({ application: "trustbridge", purpose });
  return Object.freeze({
    kind: "kms-envelope",
    keyId,
    keyVersion,
    async checkAvailability() {
      try {
        if (typeof kms.checkAvailability !== "function") throw fail();
        await kms.checkAvailability({ keyId });
        return true;
      } catch { throw fail(); }
    },
    async encryptSecret(plaintext, { purpose, aad }) {
      let dataKey;
      try {
        const generated = await kms.generateDataKey({ keyId, encryptionContext: encryptionContext(purpose) });
        dataKey = generated?.plaintextKey;
        const wrapped = generated?.encryptedDataKey;
        if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32 || !Buffer.isBuffer(wrapped) || wrapped.length < 1 || wrapped.length > 1_048_576) throw fail();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
        cipher.setAAD(kmsAad(aad, keyId, keyVersion));
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const header = Buffer.alloc(8);
        ENVELOPE_MAGIC.copy(header, 0);
        header.writeUInt32BE(wrapped.length, 4);
        return Object.freeze({ ciphertext: Buffer.concat([header, wrapped, encrypted]), nonce, authTag: cipher.getAuthTag(), keyId, keyVersion });
      } catch { throw fail(); }
      finally { dataKey?.fill(0); }
    },
    async decryptSecret(envelope, { purpose, aad }) {
      let dataKey;
      try {
        const stored = envelope?.ciphertext;
        if (!Buffer.isBuffer(stored) || stored.length < 9 || !stored.subarray(0, 4).equals(ENVELOPE_MAGIC)
          || !Buffer.isBuffer(envelope.nonce) || envelope.nonce.length !== 12 || !Buffer.isBuffer(envelope.authTag) || envelope.authTag.length !== 16
          || typeof envelope.keyId !== "string" || !Number.isInteger(envelope.keyVersion) || envelope.keyVersion < 1) throw fail();
        const wrappedLength = stored.readUInt32BE(4);
        if (wrappedLength < 1 || wrappedLength > 1_048_576 || stored.length <= 8 + wrappedLength) throw fail();
        const encryptedDataKey = stored.subarray(8, 8 + wrappedLength);
        const encryptedSecret = stored.subarray(8 + wrappedLength);
        dataKey = await kms.decryptDataKey({
          keyId: envelope.keyId,
          keyVersion: envelope.keyVersion,
          encryptedDataKey: Buffer.from(encryptedDataKey),
          encryptionContext: encryptionContext(purpose),
        });
        if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw fail();
        const decipher = createDecipheriv("aes-256-gcm", dataKey, envelope.nonce);
        decipher.setAAD(kmsAad(aad, envelope.keyId, envelope.keyVersion));
        decipher.setAuthTag(envelope.authTag);
        return Buffer.concat([decipher.update(encryptedSecret), decipher.final()]).toString("utf8");
      } catch { throw fail(); }
      finally { dataKey?.fill(0); }
    },
  });
};

export const createOpaqueSecret = () => randomBytes(32).toString("base64url");
