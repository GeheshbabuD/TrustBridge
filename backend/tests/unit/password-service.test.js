import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  PasswordInputError,
  verifyPassword,
} from "../../src/services/password.service.js";

const samplePassword = "Correct horse! Battery stapler #42";

test("bcrypt asynchronously hashes passwords without returning plaintext", async () => {
  const hash = await hashPassword(samplePassword, { saltRounds: 12 });

  assert.notEqual(hash, samplePassword);
  assert.match(hash, /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  assert.equal(await verifyPassword(samplePassword, hash), true);
});

test("bcrypt verification rejects an incorrect password", async () => {
  const hash = await hashPassword(samplePassword, { saltRounds: 12 });
  assert.equal(await verifyPassword("Different horse! Battery stapler #42", hash), false);
});

test("malformed or non-string hashes safely return false", async () => {
  for (const hash of ["", "not-a-bcrypt-hash", "$2b$12$short", null, 42]) {
    assert.equal(await verifyPassword(samplePassword, hash), false);
  }
});

test("hashing rejects invalid password inputs and unsafe work factors with safe errors", async () => {
  for (const password of [null, 42, "", "     ", "short", "a".repeat(73)]) {
    await assert.rejects(hashPassword(password, { saltRounds: 12 }), PasswordInputError);
  }

  for (const saltRounds of [11, 16, 12.5, "12"]) {
    await assert.rejects(hashPassword(samplePassword, { saltRounds }), PasswordInputError);
  }
});

test("verification rejects invalid plaintext types without exposing values", async () => {
  const secretMarker = "plaintext-secret-never-echo-this";
  const hashMarker = "$2b$12$synthetic-hash-must-not-leak";

  await assert.rejects(verifyPassword({ password: secretMarker }, hashMarker), (error) => {
    assert.ok(error instanceof PasswordInputError);
    assert.equal(error.message.includes(secretMarker), false);
    assert.equal(error.message.includes(hashMarker), false);
    return true;
  });
});

test("password operations never log plaintext or password hashes", async () => {
  const logCalls = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const method of Object.keys(originals)) console[method] = (...args) => logCalls.push(args.join(" "));

  try {
    const hash = await hashPassword(samplePassword, { saltRounds: 12 });
    await verifyPassword(samplePassword, hash);
    await verifyPassword(samplePassword, "malformed-hash");
    await assert.rejects(hashPassword("too short", { saltRounds: 12 }));
    assert.deepEqual(logCalls, []);
  } finally {
    for (const [method, original] of Object.entries(originals)) console[method] = original;
  }
});
