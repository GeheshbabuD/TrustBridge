import assert from "node:assert/strict";
import test from "node:test";
import { idempotencyKeySchema, transactionCreateSchema, transactionTransitionSchema } from "../../src/validators/transaction.validator.js";

const validCreate = {
  sellerId: "22222222-2222-4222-8222-222222222222",
  amountMinor: "12500",
  currency: "INR",
  terms: { description: "Repair service", delivery: { days: 3 } },
};

test("transaction creation accepts validated minor units, supported ISO currency and bounded JSON terms", () => {
  assert.deepEqual(transactionCreateSchema.parse(validCreate), validCreate);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, amountMinor: 1.25 }).success, false);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, amountMinor: "0" }).success, false);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, amountMinor: "9223372036854775808" }).success, false);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, currency: "ZZZ" }).success, false);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, status: "FUNDED" }).success, false);
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, terms: { value: "x".repeat(32769) } }).success, false);
});

test("transaction and idempotency inputs reject extra or malformed fields", () => {
  assert.equal(transactionCreateSchema.safeParse({ ...validCreate, buyerId: "33333333-3333-4333-8333-333333333333" }).success, false);
  assert.equal(idempotencyKeySchema.safeParse("short").success, false);
  assert.equal(idempotencyKeySchema.safeParse("valid:key_12345").success, true);
  assert.equal(transactionTransitionSchema.safeParse({ status: "ACCEPTED", expectedVersion: 1, actorUserId: "forged" }).success, false);
  assert.equal(transactionTransitionSchema.safeParse({ status: "ACCEPTED", expectedVersion: 0 }).success, false);
});
