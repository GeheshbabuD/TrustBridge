import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} model in canonical Prisma schema`);
  return match[1];
};

test("transaction binds named buyer, seller and creator relations and stores minor-unit terms", () => {
  const transaction = modelBlock("Transaction");
  assert.match(transaction, /buyerId\s+String/);
  assert.match(transaction, /sellerId\s+String/);
  assert.match(transaction, /createdById\s+String/);
  assert.match(transaction, /buyer\s+User\s+@relation\("TransactionBuyer"/);
  assert.match(transaction, /seller\s+User\s+@relation\("TransactionSeller"/);
  assert.match(transaction, /createdBy\s+User\s+@relation\("TransactionCreator"/);
  assert.match(transaction, /status\s+TransactionStatus/);
  assert.match(transaction, /amountMinor\s+BigInt/);
  assert.match(transaction, /currency\s+String\s+@db\.Char\(3\)/);
  assert.match(transaction, /terms\s+Json\s+@db\.JsonB/);
  assert.match(transaction, /version\s+Int/);
  assert.match(transaction, /@@index\(\[buyerId, status, createdAt\]/);
  assert.match(transaction, /@@index\(\[sellerId, status, createdAt\]/);
  assert.match(transaction, /onDelete: Restrict/);
});

test("participants are unique per transaction/user and role and cannot outlive either owner", () => {
  const participant = modelBlock("TransactionParticipant");
  assert.match(participant, /@@id\(\[transactionId, userId\]/);
  assert.match(participant, /@@unique\(\[transactionId, role\]/);
  assert.match(participant, /transaction\s+Transaction\s+@relation/);
  assert.match(participant, /user\s+User\s+@relation/);
  assert.equal((participant.match(/onDelete: Restrict/g) ?? []).length, 2);
  assert.match(participant, /@@index\(\[userId, role, joinedAt\]/);
});

test("payment attempts keep independent status, provider reference and scoped idempotency", () => {
  const attempt = modelBlock("PaymentAttempt");
  assert.match(attempt, /status\s+PaymentAttemptStatus/);
  assert.match(attempt, /amountMinor\s+BigInt/);
  assert.match(attempt, /currency\s+String\s+@db\.Char\(3\)/);
  assert.match(attempt, /@@unique\(\[transactionId, idempotencyKey\]/);
  assert.match(attempt, /@@unique\(\[provider, providerReference\]/);
  assert.match(attempt, /transaction\s+Transaction\s+@relation\(fields: \[transactionId, currency\]/);
  assert.match(attempt, /onDelete: Restrict/);
  assert.doesNotMatch(attempt, /cardNumber|cvv|secret|payload/i);
});

test("escrow is one currency-matched internal record per transaction and restricts deletion", () => {
  const escrow = modelBlock("Escrow");
  assert.match(escrow, /transactionId\s+String/);
  assert.match(escrow, /@@unique\(\[transactionId, currency\]/);
  assert.match(escrow, /balanceMinor\s+BigInt/);
  assert.match(escrow, /status\s+EscrowStatus/);
  assert.match(escrow, /fundedAt\s+DateTime\?/);
  assert.match(escrow, /releasedAt\s+DateTime\?/);
  assert.match(escrow, /refundedAt\s+DateTime\?/);
  assert.match(escrow, /onDelete: Restrict/);
  assert.match(escrow, /ledgerAccount\s+LedgerAccount\?/);
  assert.match(schema, /internal workflow\/accounting record only; it does not represent legal custody/i);
});

test("ledger journals, accounts and entries retain currency and transaction integrity", () => {
  const account = modelBlock("LedgerAccount");
  const journal = modelBlock("LedgerJournal");
  const entry = modelBlock("LedgerEntry");

  assert.match(account, /accountType\s+LedgerAccountType/);
  assert.match(account, /transactionId\s+String/);
  assert.match(account, /currency\s+String\s+@db\.Char\(3\)/);
  assert.match(account, /escrow\s+Escrow\?\s+@relation\("EscrowLedgerAccount"/);
  assert.match(account, /@@unique\(\[escrowId, transactionId, currency\]/);
  assert.match(account, /@@unique\(\[transactionId, accountCode, currency\]/);
  assert.match(journal, /operationId\s+String\s+@unique/);
  assert.match(journal, /reversalOf\s+LedgerJournal\?/);
  assert.match(journal, /reversals\s+LedgerJournal\[\]/);
  assert.match(journal, /onDelete: Restrict/g);
  assert.match(entry, /amountMinor\s+BigInt/);
  assert.match(entry, /direction\s+LedgerDirection/);
  assert.match(entry, /journal\s+LedgerJournal\s+@relation\(fields: \[journalId, transactionId, currency\]/);
  assert.match(entry, /account\s+LedgerAccount\s+@relation\(fields: \[accountId, transactionId, currency\]/);
  assert.equal((entry.match(/onDelete: Restrict/g) ?? []).length, 2);
  assert.doesNotMatch(schema, /\b(Float|Decimal)\b/);
});
