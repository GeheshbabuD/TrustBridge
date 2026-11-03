import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} model in canonical Prisma schema`);
  return match[1];
};

test("risk assessments and AI analyses retain provenance, subjects and advisory review fields", () => {
  const risk = modelBlock("RiskAssessment");
  const ai = modelBlock("AIAnalysis");
  assert.match(risk, /transaction\s+Transaction\s+@relation/);
  assert.match(risk, /status\s+AiReviewStatus/);
  assert.match(risk, /rulesetVersion\s+String/);
  assert.match(risk, /reviewer\s+User\?/);
  assert.match(risk, /@@index\(\[transactionId, status, createdAt\]/);
  assert.match(ai, /transaction\s+Transaction\?/);
  assert.match(ai, /dispute\s+Dispute\?/);
  assert.match(ai, /status\s+AiReviewStatus/);
  assert.match(ai, /provider\s+String/);
  assert.match(ai, /modelIdentifier\s+String/);
  assert.match(ai, /modelVersion\s+String/);
  assert.match(ai, /result\s+Json/);
  assert.match(ai, /explainability\s+Json\?/);
  assert.match(ai, /@@index\(\[disputeId, status, createdAt\]/);
  assert.doesNotMatch(`${risk}\n${ai}`, /secret|credential|rawEvidence/i);
});

test("blockchain records are transaction-scoped, idempotent and store hashes rather than secrets", () => {
  const chain = modelBlock("BlockchainRecord");
  assert.match(chain, /transaction\s+Transaction\s+@relation/);
  assert.match(chain, /status\s+BlockchainOperationStatus/);
  assert.match(chain, /eventHash\s+String/);
  assert.match(chain, /@@unique\(\[transactionId, idempotencyKey\]/);
  assert.match(chain, /@@unique\(\[network, transactionHash\]/);
  assert.match(chain, /@@index\(\[transactionId, status, createdAt\]/);
  assert.doesNotMatch(chain, /privateKey|seedPhrase|signingSecret|payload\s+Json|personalData/i);
});

test("refresh tokens persist hashes and rotation lineage with restrictive relations", () => {
  const refresh = modelBlock("RefreshToken");
  assert.match(refresh, /user\s+User\s+@relation/);
  assert.match(refresh, /tokenHash\s+String\s+@unique/);
  assert.match(refresh, /familyId\s+String/);
  assert.match(refresh, /rotatedFromId\s+String\?/);
  assert.match(refresh, /rotatedFrom\s+RefreshToken\?/);
  assert.match(refresh, /reuseDetectedAt\s+DateTime\?/);
  assert.match(refresh, /expiresAt\s+DateTime/);
  assert.equal((refresh.match(/onDelete: Restrict/g) ?? []).length, 2);
  assert.doesNotMatch(refresh, /rawToken|refreshToken\s+String|password|secret/i);
});

test("new records avoid monetary floats and cascading deletion", () => {
  for (const name of ["RiskAssessment", "AIAnalysis", "BlockchainRecord", "RefreshToken"]) {
    assert.doesNotMatch(modelBlock(name), /onDelete:\s*Cascade/);
  }
  assert.doesNotMatch(schema, /\b(Float|Decimal)\b/);
});
