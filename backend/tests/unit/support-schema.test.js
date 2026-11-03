import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} model in canonical Prisma schema`);
  return match[1];
};

test("disputes use the existing status enum and real transaction/user relations", () => {
  const dispute = modelBlock("Dispute");
  const user = modelBlock("User");
  const transaction = modelBlock("Transaction");
  assert.match(dispute, /transactionId\s+String/);
  assert.match(dispute, /transaction\s+Transaction\s+@relation/);
  assert.match(dispute, /openedBy\s+User\s+@relation\("DisputeOpenedBy"/);
  assert.match(dispute, /resolvedBy\s+User\?\s+@relation\("DisputeResolvedBy"/);
  assert.match(dispute, /status\s+DisputeStatus/);
  assert.match(dispute, /category\s+String/);
  assert.match(dispute, /description\s+String/);
  assert.match(dispute, /resolvedAt\s+DateTime\?/);
  assert.match(dispute, /@@index\(\[transactionId, status, createdAt\]/);
  assert.match(dispute, /onDelete: Restrict/g);
  assert.match(user, /openedDisputes\s+Dispute\[\]/);
  assert.match(transaction, /disputes\s+Dispute\[\]/);
  assert.doesNotMatch(dispute, /@@unique\(\[transactionId\]/);
});

test("evidence stores private metadata references only and retains dispute/uploader relations", () => {
  const evidence = modelBlock("Evidence");
  assert.match(evidence, /dispute\s+Dispute\s+@relation/);
  assert.match(evidence, /uploadedBy\s+User\s+@relation\("EvidenceUploader"/);
  assert.match(evidence, /storageObjectKey\s+String\s+@unique/);
  assert.match(evidence, /originalFilename\s+String\?/);
  assert.match(evidence, /contentType\s+String/);
  assert.match(evidence, /sizeBytes\s+BigInt/);
  assert.match(evidence, /sha256Hash\s+String/);
  assert.match(evidence, /@@index\(\[disputeId, createdAt\]/);
  assert.equal((evidence.match(/onDelete: Restrict/g) ?? []).length, 2);
  assert.doesNotMatch(evidence, /fileContents?\s|publicUrl|downloadUrl|signedUrl|accessToken|credential/i);
});

test("notifications belong to a recipient and use durable read/dedupe fields", () => {
  const notification = modelBlock("Notification");
  assert.match(notification, /recipient\s+User\s+@relation\("NotificationRecipient"/);
  assert.match(notification, /type\s+String/);
  assert.match(notification, /title\s+String/);
  assert.match(notification, /message\s+String\?/);
  assert.match(notification, /dedupeKey\s+String\?/);
  assert.match(notification, /readAt\s+DateTime\?/);
  assert.match(notification, /@@unique\(\[recipientId, dedupeKey\]/);
  assert.match(notification, /@@index\(\[recipientId, readAt, createdAt\]/);
  assert.match(notification, /onDelete: Restrict/);
  assert.doesNotMatch(notification, /password|token|card|evidence|credential/i);
});

test("audit logs support optional actors, correlation and append-only schema shape", () => {
  const audit = modelBlock("AuditLog");
  assert.match(audit, /actorUserId\s+String\?/);
  assert.match(audit, /actor\s+User\?\s+@relation\("AuditActor"/);
  assert.match(audit, /action\s+String/);
  assert.match(audit, /entityType\s+String/);
  assert.match(audit, /entityId\s+String/);
  assert.match(audit, /requestId\s+String\?/);
  assert.match(audit, /metadata\s+Json\?/);
  assert.match(audit, /createdAt\s+DateTime/);
  assert.match(audit, /@@index\(\[actorUserId, createdAt\]/);
  assert.match(audit, /@@index\(\[entityType, entityId, createdAt\]/);
  assert.match(audit, /@@index\(\[requestId, createdAt\]/);
  assert.match(audit, /onDelete: Restrict/);
  assert.doesNotMatch(audit, /updatedAt|password|token|cardNumber|evidenceContent/i);
});

test("support schema has no cascading deletion or floating/decimal monetary fields", () => {
  for (const modelName of ["Dispute", "Evidence", "Notification", "AuditLog"]) {
    assert.doesNotMatch(modelBlock(modelName), /onDelete:\s*Cascade/);
  }
  assert.doesNotMatch(schema, /\b(Float|Decimal)\b/);
});
