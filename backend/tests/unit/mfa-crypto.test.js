import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createKmsEnvelopeEncryptionProvider, createLocalDevelopmentEncryptionProvider, createMfaCrypto, MfaCryptoError } from "../../src/services/mfa-crypto.service.js";

const key = Buffer.alloc(32, 7);
const provider = createLocalDevelopmentEncryptionProvider({ environment: () => ({ nodeEnv: "test", mfa: { localEncryptionKey: key } }) });

test("AES-GCM MFA envelope round-trips and uses fresh nonce per encryption", async () => {
  const crypto = createMfaCrypto({ provider });
  const first = await crypto.encrypt("synthetic-totp-secret", { userId: "user-1" });
  const second = await crypto.encrypt("synthetic-totp-secret", { userId: "user-1" });
  assert.equal(await crypto.decrypt(first, { userId: "user-1" }), "synthetic-totp-secret");
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.equal(first.authTag.length, 16);
  assert.equal(first.keyId, "local-development");
  assert.equal(first.keyVersion, 1);
  assert.equal(JSON.stringify(first).includes("synthetic-totp-secret"), false);
});

test("authentication tag and user-bound AAD failures fail safely", async () => {
  const crypto = createMfaCrypto({ provider });
  const envelope = await crypto.encrypt("secret", { userId: "user-1" });
  const damaged = { ...envelope, authTag: Buffer.alloc(16) };
  await assert.rejects(crypto.decrypt(damaged, { userId: "user-1" }), (error) => error instanceof MfaCryptoError && !error.message.includes("synthetic-totp-secret"));
  await assert.rejects(crypto.decrypt(envelope, { userId: "user-2" }), MfaCryptoError);
});

test("missing keys never fall back to a local or hardcoded encryption key", async () => {
  const crypto = createMfaCrypto({ provider: { async encryptSecret() { throw new Error("secret provider detail"); }, async decryptSecret() { throw new Error("secret provider detail"); } } });
  await assert.rejects(crypto.encrypt("secret", { userId: "u" }), (error) => error instanceof MfaCryptoError && !error.message.includes("provider detail"));
  await assert.rejects(crypto.decrypt({}, { userId: "u" }), MfaCryptoError);
});

test("local adapter refuses production and missing-key configurations", async () => {
  const production = createMfaCrypto({ provider: createLocalDevelopmentEncryptionProvider({ environment: () => ({ nodeEnv: "production", mfa: {} }) }) });
  const unconfigured = createMfaCrypto({ provider: createLocalDevelopmentEncryptionProvider({ environment: () => ({ nodeEnv: "development", mfa: {} }) }) });
  await assert.rejects(production.encrypt("secret", { userId: "u" }), MfaCryptoError);
  await assert.rejects(unconfigured.encrypt("secret", { userId: "u" }), MfaCryptoError);
});

const makeKmsMock = () => {
  const wrappedKeys = new Map();
  return {
    async checkAvailability() { return true; },
    async generateDataKey({ keyId, encryptionContext }) {
      assert.equal(keyId, "test-key");
      assert.deepEqual(encryptionContext, { application: "trustbridge", purpose: "totp" });
      const plaintextKey = randomBytes(32);
      const encryptedDataKey = randomBytes(48);
      wrappedKeys.set(encryptedDataKey.toString("base64"), Buffer.from(plaintextKey));
      return { plaintextKey, encryptedDataKey };
    },
    async decryptDataKey({ keyId, keyVersion, encryptedDataKey }) {
      assert.equal(keyId, "test-key");
      assert.ok(keyVersion >= 1);
      const key = wrappedKeys.get(encryptedDataKey.toString("base64"));
      if (!key) throw new Error("mock KMS has no wrapped key");
      return Buffer.from(key);
    },
  };
};

test("KMS envelope adapter wraps a fresh DEK and authenticates user/purpose data", async () => {
  const kms = makeKmsMock();
  const provider = createKmsEnvelopeEncryptionProvider({ kms, keyId: "test-key", keyVersion: 3 });
  const crypto = createMfaCrypto({ provider });
  const first = await crypto.encrypt("synthetic-secret", { userId: "user-a", purpose: "totp" });
  const second = await crypto.encrypt("synthetic-secret", { userId: "user-a", purpose: "totp" });
  assert.equal(provider.kind, "kms-envelope");
  assert.equal(first.keyVersion, 3);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(await crypto.decrypt(first, { userId: "user-a", purpose: "totp" }), "synthetic-secret");
  await assert.rejects(crypto.decrypt(first, { userId: "user-b", purpose: "totp" }), MfaCryptoError);
  await assert.rejects(crypto.decrypt(first, { userId: "user-a", purpose: "pending" }), MfaCryptoError);
  assert.equal(first.ciphertext.includes(Buffer.from("synthetic-secret")), false);
});

test("KMS adapter supports decrypting old key versions through the key resolver", async () => {
  const kms = makeKmsMock();
  const oldProvider = createMfaCrypto({ provider: createKmsEnvelopeEncryptionProvider({ kms, keyId: "test-key", keyVersion: 2 }) });
  const rotatedProvider = createMfaCrypto({ provider: createKmsEnvelopeEncryptionProvider({ kms, keyId: "test-key", keyVersion: 3 }) });
  const oldEnvelope = await oldProvider.encrypt("rotation-secret", { userId: "user-a" });
  assert.equal(await rotatedProvider.decrypt(oldEnvelope, { userId: "user-a" }), "rotation-secret");
  assert.equal(await rotatedProvider.encrypt("new-secret", { userId: "user-a" }).then((value) => value.keyVersion), 3);
});

test("KMS outages, malformed envelopes and missing health support fail closed", async () => {
  const broken = createMfaCrypto({ provider: createKmsEnvelopeEncryptionProvider({
    keyId: "test-key", keyVersion: 1,
    kms: { async generateDataKey() { throw new Error("secret endpoint detail"); }, async decryptDataKey() { throw new Error("secret endpoint detail"); }, async checkAvailability() { throw new Error("secret endpoint detail"); } },
  }) });
  await assert.rejects(broken.checkAvailability(), (error) => error instanceof MfaCryptoError && !error.message.includes("endpoint"));
  await assert.rejects(broken.encrypt("synthetic", { userId: "user-a" }), MfaCryptoError);
  const crypto = createMfaCrypto({ provider: createKmsEnvelopeEncryptionProvider({ kms: makeKmsMock(), keyId: "test-key", keyVersion: 1 }) });
  await assert.rejects(crypto.decrypt({ ciphertext: Buffer.from("bad"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyId: "test-key", keyVersion: 1 }, { userId: "user-a" }), MfaCryptoError);
});

test("KMS adapter requires explicit client and key version configuration", () => {
  assert.throws(() => createKmsEnvelopeEncryptionProvider({ keyId: "test-key", keyVersion: 1 }), /configured KMS client/);
  assert.throws(() => createKmsEnvelopeEncryptionProvider({ kms: makeKmsMock(), keyId: "test-key", keyVersion: 0 }), /configured KMS client/);
});
