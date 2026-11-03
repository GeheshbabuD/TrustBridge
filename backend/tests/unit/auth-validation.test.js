import assert from "node:assert/strict";
import test from "node:test";
import {
  loginEmailSchema,
  loginPasswordSchema,
  loginSchema,
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_MIN_CODE_POINTS,
  registrationEmailSchema,
  registrationPasswordSchema,
  registrationSchema,
} from "../../src/validators/auth.validator.js";

test("registration and login emails are trimmed and normalized to lowercase", () => {
  assert.equal(registrationEmailSchema.parse("  Alice.Example@Example.TEST  "), "alice.example@example.test");
  assert.equal(loginEmailSchema.parse(" ALICE@EXAMPLE.TEST "), "alice@example.test");
  assert.deepEqual(registrationSchema.parse({ email: " A@EXAMPLE.TEST ", password: "long enough password" }), {
    email: "a@example.test",
    password: "long enough password",
  });
  assert.equal(loginSchema.parse({ email: " A@EXAMPLE.TEST ", password: "x" }).password, "x");
});

test("email schemas reject malformed and overlong addresses", () => {
  for (const email of ["", "not-an-email", "a@@example.test", `${"a".repeat(310)}@example.test`]) {
    assert.equal(registrationEmailSchema.safeParse(email).success, false);
  }
});

test("registration password enforces documented minimum and bcrypt byte maximum", () => {
  assert.equal(registrationPasswordSchema.safeParse("a".repeat(PASSWORD_MIN_CODE_POINTS - 1)).success, false);
  assert.equal(registrationPasswordSchema.safeParse("a".repeat(PASSWORD_MIN_CODE_POINTS)).success, true);
  assert.equal(registrationPasswordSchema.safeParse("a".repeat(PASSWORD_MAX_UTF8_BYTES)).success, true);
  assert.equal(registrationPasswordSchema.safeParse("a".repeat(PASSWORD_MAX_UTF8_BYTES + 1)).success, false);
});

test("password schemas reject empty or whitespace-only inputs without trimming valid passwords", () => {
  for (const password of ["", "   ", "\t\n  "]) {
    assert.equal(registrationPasswordSchema.safeParse(password).success, false);
    assert.equal(loginPasswordSchema.safeParse(password).success, false);
  }

  const password = "  Legit! passphrase 42  ";
  assert.equal(registrationPasswordSchema.parse(password), password);
  assert.equal(registrationPasswordSchema.safeParse("Symbols !@#$%^&*()_+=[]{}?").success, true);
});

test("registration and login schemas reject unrecognized fields", () => {
  assert.equal(registrationSchema.safeParse({ email: "a@example.test", password: "long enough password", role: "ADMIN" }).success, false);
  assert.equal(loginSchema.safeParse({ email: "a@example.test", password: "x", passwordHash: "private" }).success, false);
});

test("registration accepts an optional trimmed profile display name within the Profile limit", () => {
  const base = { email: "a@example.test", password: "long enough password" };
  assert.equal(registrationSchema.parse({ ...base }).displayName, undefined);
  assert.equal(registrationSchema.parse({ ...base, displayName: "  Example Buyer  " }).displayName, "Example Buyer");
  assert.equal(registrationSchema.safeParse({ ...base, displayName: "   " }).success, false);
  assert.equal(registrationSchema.safeParse({ ...base, displayName: "x".repeat(121) }).success, false);
});

test("validation error messages and issue data do not contain submitted password values", () => {
  const marker = "private-password-marker-DO-NOT-RETURN";
  const submittedPassword = marker.repeat(3);
  const result = registrationPasswordSchema.safeParse(submittedPassword);
  assert.equal(result.success, false);
  const errorOutput = `${result.error.message} ${JSON.stringify(result.error.issues)}`;
  assert.equal(errorOutput.includes(submittedPassword), false);
});
