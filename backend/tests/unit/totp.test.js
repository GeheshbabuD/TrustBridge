import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase32, encodeBase32, generateTotp, generateTotpSecret, verifyTotp } from "../../src/services/totp.service.js";

const rfcSecret = encodeBase32(Buffer.from("12345678901234567890", "ascii"));

test("RFC 6238 SHA-1 vectors match the published eight-digit values", () => {
  const vectors = [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(generateTotp(rfcSecret, { at: new Date(seconds * 1000), digits: 8 }).code, expected);
  }
});

test("generated secrets contain at least 160 bits and are independently random", () => {
  const first = generateTotpSecret();
  const second = generateTotpSecret();
  assert.equal(decodeBase32(first).length, 20);
  assert.equal(decodeBase32(second).length, 20);
  assert.notEqual(first, second);
});

test("six-digit TOTP verifies at the exact step boundary and within configured skew", () => {
  const codeAtStepZero = generateTotp(rfcSecret, { timeStep: 0 }).code;
  const codeAtStepOne = generateTotp(rfcSecret, { timeStep: 1 }).code;
  assert.equal(codeAtStepZero.length, 6);
  assert.deepEqual(verifyTotp(rfcSecret, codeAtStepOne, { at: new Date(30_000), window: 0 }), { valid: true, timeStep: 1 });
  assert.deepEqual(verifyTotp(rfcSecret, codeAtStepZero, { at: new Date(30_000), window: 1 }), { valid: true, timeStep: 0 });
  assert.deepEqual(verifyTotp(rfcSecret, codeAtStepZero, { at: new Date(60_000), window: 1 }), { valid: false, timeStep: null });
  assert.deepEqual(verifyTotp(rfcSecret, codeAtStepZero, { at: new Date(30_000), window: 0 }), { valid: false, timeStep: null });
});

test("malformed codes, secrets, clocks and skew parameters fail safely", () => {
  for (const code of ["", "12345", "1234567", "12a456"]) assert.equal(verifyTotp(rfcSecret, code).valid, false);
  assert.equal(verifyTotp("INVALID0", "123456").valid, false);
  assert.equal(verifyTotp(rfcSecret, "123456", { at: new Date(Number.NaN) }).valid, false);
  assert.throws(() => verifyTotp(rfcSecret, "123456", { window: 3 }));
  assert.throws(() => generateTotp("INVALID0", { timeStep: 10 }));
});
