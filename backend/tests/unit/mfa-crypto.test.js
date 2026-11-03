import assert from "node:assert/strict";
import test from "node:test";
import { createLocalDevelopmentEncryptionProvider, createMfaCrypto, MfaCryptoError } from "../../src/services/mfa-crypto.service.js";

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
