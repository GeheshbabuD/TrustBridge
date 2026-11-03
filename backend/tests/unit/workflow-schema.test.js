import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} model in canonical Prisma schema`);
  return match[1];
};

test("transaction status history records real transaction, status transition, actor and chronology", () => {
  const history = modelBlock("TransactionStatusHistory");
  assert.match(history, /transaction\s+Transaction\s+@relation/);
  assert.match(history, /previousStatus\s+TransactionStatus\?/);
  assert.match(history, /newStatus\s+TransactionStatus/);
  assert.match(history, /actor\s+User\?/);
  assert.match(history, /reason\s+String/);
  assert.match(history, /createdAt\s+DateTime/);
  assert.match(history, /@@unique\(\[transactionId, version\]/);
  assert.match(history, /@@index\(\[transactionId, createdAt\]/);
  assert.match(history, /onDelete: Restrict/g);
  assert.match(modelBlock("Transaction"), /statusHistory\s+TransactionStatusHistory\[\]/);
  assert.match(modelBlock("User"), /transactionStatusHistory\s+TransactionStatusHistory\[\]/);
});

test("webhook inbox is provider-account scoped and tracks minimal, leased processing", () => {
  const webhook = modelBlock("WebhookEvent");
  assert.match(webhook, /provider\s+String/);
  assert.match(webhook, /providerAccountScope\s+String/);
  assert.match(webhook, /eventId\s+String/);
  assert.match(webhook, /eventType\s+String/);
  assert.match(webhook, /receivedAt\s+DateTime/);
  assert.match(webhook, /status\s+WebhookProcessingStatus/);
  assert.match(webhook, /attemptCount\s+Int/);
  assert.match(webhook, /lastErrorCode\s+String\?/);
  assert.match(webhook, /eventData\s+Json\?/);
  assert.match(webhook, /paymentAttempt\s+PaymentAttempt\?/);
  assert.match(webhook, /@@unique\(\[provider, providerAccountScope, eventId\]/);
  assert.match(webhook, /@@index\(\[status, nextAttemptAt, receivedAt\]/);
  assert.match(webhook, /leaseExpiresAt\s+DateTime\?/);
  assert.doesNotMatch(webhook, /rawPayload|authorizationHeader|secret|password|cardNumber|accessToken/i);
});

test("idempotency records scope keys, fingerprint, resource, lifecycle and claim lease", () => {
  const idem = modelBlock("IdempotencyOperation");
  assert.match(idem, /operationScope\s+String/);
  assert.match(idem, /idempotencyKey\s+String/);
  assert.match(idem, /requestFingerprint\s+String/);
  assert.match(idem, /status\s+IdempotencyStatus/);
  assert.match(idem, /resourceType\s+String\?/);
  assert.match(idem, /resourceId\s+String\?/);
  assert.match(idem, /createdAt\s+DateTime/);
  assert.match(idem, /completedAt\s+DateTime\?/);
  assert.match(idem, /expiresAt\s+DateTime/);
  assert.match(idem, /@@unique\(\[operationScope, idempotencyKey\]/);
  assert.match(idem, /@@index\(\[status, leaseExpiresAt, createdAt\]/);
  assert.doesNotMatch(idem, /requestBody|rawRequest|responseBody|credential|secret/i);
});

test("outbox supports durable publication, bounded retries and concurrent worker leases", () => {
  const outbox = modelBlock("OutboxEvent");
  assert.match(outbox, /eventKey\s+String\s+@unique/);
  assert.match(outbox, /eventType\s+String/);
  assert.match(outbox, /aggregateType\s+String/);
  assert.match(outbox, /aggregateId\s+String/);
  assert.match(outbox, /transaction\s+Transaction\?/);
  assert.match(outbox, /payload\s+Json/);
  assert.match(outbox, /status\s+OutboxStatus/);
  assert.match(outbox, /attemptCount\s+Int/);
  assert.match(outbox, /nextAttemptAt\s+DateTime/);
  assert.match(outbox, /leaseOwner\s+String\?/);
  assert.match(outbox, /leaseExpiresAt\s+DateTime\?/);
  assert.match(outbox, /lastErrorCode\s+String\?/);
  assert.match(outbox, /publishedAt\s+DateTime\?/);
  assert.match(outbox, /@@index\(\[status, nextAttemptAt, createdAt\]/);
  assert.match(outbox, /@@index\(\[aggregateType, aggregateId, createdAt\]/);
  assert.doesNotMatch(outbox, /password|authorization|paymentCredential|privateKey|rawEvidence/i);
});

test("workflow models use separate lifecycle enums, restrict history deletion and avoid decimal money", () => {
  assert.match(schema, /enum WebhookProcessingStatus\s*\{/);
  assert.match(schema, /enum IdempotencyStatus\s*\{/);
  assert.match(schema, /enum OutboxStatus\s*\{/);
  for (const name of ["TransactionStatusHistory", "WebhookEvent", "IdempotencyOperation", "OutboxEvent"]) {
    assert.doesNotMatch(modelBlock(name), /onDelete:\s*Cascade/);
  }
  assert.doesNotMatch(schema, /\b(Float|Decimal)\b/);
});
