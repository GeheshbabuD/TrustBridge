import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError, createJsonAiAdapter, createMockAiAdapter } from "../../src/services/ai-provider.adapter.js";
import { transactionRiskInputSchema, transactionRiskResultSchema } from "../../src/validators/ai.validator.js";
import { disputeAssistanceInputSchema, disputeAssistanceResultSchema } from "../../src/validators/ai.validator.js";

const input = { inputDataVersion: "transaction-risk.v1", transaction: { status: "FUNDED", amountMinor: "75000", currency: "INR", ageDays: 2, version: 4 }, paymentAttempts: { created: 0, pending: 0, captured: 1, failed: 0, cancelled: 0 }, disputes: { open: 0, underReview: 0, resolved: 0, closed: 0 } };
const result = { score: 18, riskLevel: "LOW", indicators: [{ code: "RECENTLY_FUNDED", severity: "LOW", explanation: "The transaction was funded recently." }], confidenceLevel: "LOW", recommendation: "NONE", summary: "No strong risk indicator is present." };
const envelope = (value = result, model = { identifier: "risk-model", version: "v1" }) => new Response(JSON.stringify({ model, result: value }), { status: 200, headers: { "content-type": "application/json" } });
const adapter = (fetchImpl) => createJsonAiAdapter({ provider: "approved-gateway", endpoint: "https://gateway.example.test/assess", apiKey: "synthetic-test-key", modelIdentifier: "risk-model", modelVersion: "v1", fetchImpl });
const disputeInput = { inputDataVersion: "dispute-assistance.v1", dispute: { category: "QUALITY", status: "UNDER_REVIEW", description: "Delivered work differs from agreed scope.", ageDays: 2, version: 3 }, evidenceCounts: { DELIVERY: 0, WORK_PROGRESS: 1, COMMUNICATION: 0, OTHER: 0 } };
const disputeResult = { summary: "The claim concerns a difference from agreed scope.", suggestedCategory: "SCOPE", missingEvidenceCategories: ["DELIVERY"], reviewSteps: ["COMPARE_AGREED_TERMS", "HUMAN_RESOLUTION_REQUIRED"], advisoryOnly: true };

test("risk input and output schemas are strict and bound all model output fields", () => {
  assert.equal(transactionRiskInputSchema.parse(input).transaction.amountMinor, "75000");
  assert.throws(() => transactionRiskInputSchema.parse({ ...input, transaction: { ...input.transaction, buyerEmail: "private@example.test" } }));
  assert.throws(() => transactionRiskResultSchema.parse({ ...result, action: "RELEASE_FUNDS" }));
  assert.throws(() => transactionRiskResultSchema.parse({ ...result, score: 101 }));
  assert.throws(() => transactionRiskResultSchema.parse({ ...result, summary: "Contact private@example.test for details." }));
  assert.throws(() => transactionRiskResultSchema.parse({ ...result, summary: "Bearer secret-token" }));
});

test("JSON adapter sends only validated structured data and returns configured provenance", async () => {
  let sent;
  const output = await adapter(async (_url, options) => { sent = JSON.parse(options.body); assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer synthetic-test-key"); return envelope(); }).assessTransactionRisk(input);
  assert.deepEqual(Object.keys(sent.input), Object.keys(input));
  assert.equal(sent.protocol, "trustbridge.ai.transaction-risk.v1");
  assert.equal(output.provider, "approved-gateway"); assert.equal(output.modelVersion, "v1");
});

test("adapter retries a transient server failure once and maps provider throttling safely", async () => {
  let calls = 0;
  const retried = await adapter(async () => ++calls === 1 ? new Response("", { status: 503 }) : envelope()).assessTransactionRisk(input);
  assert.equal(calls, 2); assert.equal(retried.result.score, 18);
  await assert.rejects(adapter(async () => new Response("", { status: 429 })).assessTransactionRisk(input), (error) => error instanceof AiProviderError && error.code === "AI_PROVIDER_RATE_LIMITED");
});

test("adapter fails closed for malformed, mismatched and oversized provider responses", async () => {
  await assert.rejects(adapter(async () => envelope({ ...result, score: "high" })).assessTransactionRisk(input), (error) => error.code === "AI_PROVIDER_INVALID_RESPONSE");
  await assert.rejects(adapter(async () => envelope(result, { identifier: "other-model", version: "v1" })).assessTransactionRisk(input), (error) => error.code === "AI_PROVIDER_INVALID_RESPONSE");
  await assert.rejects(adapter(async () => new Response("x".repeat(65537), { status: 200 })).assessTransactionRisk(input), (error) => error.code === "AI_PROVIDER_INVALID_RESPONSE");
});

test("adapter bounds network retries and mock adapter is deterministic", async () => {
  let calls = 0;
  await assert.rejects(adapter(async () => { calls += 1; throw new Error("private provider detail"); }).assessTransactionRisk(input), (error) => error.code === "AI_PROVIDER_UNAVAILABLE" && !error.message.includes("private"));
  assert.equal(calls, 2);
  let timeoutCalls = 0;
  await assert.rejects(adapter(async (_url, options) => { timeoutCalls += 1; assert.ok(options.signal instanceof AbortSignal); throw new DOMException("synthetic timeout", "TimeoutError"); }).assessTransactionRisk(input), (error) => error.code === "AI_PROVIDER_UNAVAILABLE");
  assert.equal(timeoutCalls, 2);
  assert.equal((await createMockAiAdapter({ result }).assessTransactionRisk(input)).result.score, 18);
});

test("dispute assistance schemas are strict and adapter sends only sanitized metadata without evidence contents", async () => {
  const safeInput = disputeAssistanceInputSchema.parse(disputeInput);
  assert.throws(() => disputeAssistanceInputSchema.parse({ ...disputeInput, evidenceBytes: "private" }));
  assert.throws(() => disputeAssistanceInputSchema.parse({ ...disputeInput, dispute: { ...disputeInput.dispute, description: "Contact private@example.test" } }));
  assert.throws(() => disputeAssistanceInputSchema.parse({ ...disputeInput, dispute: { ...disputeInput.dispute, description: "Call +1 (212) 555-1212" } }));
  assert.throws(() => disputeAssistanceResultSchema.parse({ ...disputeResult, action: "REFUND" }));
  assert.throws(() => disputeAssistanceResultSchema.parse({ ...disputeResult, summary: "Contact private@example.test" }));
  let sent;
  const response = await adapter(async (_url, options) => { sent = JSON.parse(options.body); return envelope(disputeResult); }).assessDispute(safeInput);
  assert.equal(sent.protocol, "trustbridge.ai.dispute-assistance.v1");
  assert.deepEqual(sent.input, safeInput);
  assert.equal(response.result.advisoryOnly, true);
  assert.equal((await createMockAiAdapter({ disputeResult }).assessDispute(safeInput)).result.suggestedCategory, "SCOPE");
  await assert.rejects(adapter(async () => envelope({ ...disputeResult, advisoryOnly: false })).assessDispute(safeInput), (error) => error.code === "AI_PROVIDER_INVALID_RESPONSE");
});
