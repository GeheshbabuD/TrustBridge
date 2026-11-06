import { disputeAssistanceInputSchema, disputeAssistanceResultSchema, transactionRiskInputSchema, transactionRiskResultSchema } from "../validators/ai.validator.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const transientStatus = new Set([500, 502, 503, 504]);

export class AiProviderError extends Error {
  constructor(code) { super("AI provider request failed"); this.name = "AiProviderError"; this.code = code; }
}

export const createJsonAiAdapter = ({ provider, endpoint, apiKey, modelIdentifier, modelVersion, timeoutMs = 5000, fetchImpl = globalThis.fetch }) => {
  if (typeof provider !== "string" || !provider || typeof endpoint !== "string" || !apiKey || !modelIdentifier || !modelVersion || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000 || typeof fetchImpl !== "function") throw new TypeError("Invalid AI adapter configuration");
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("Invalid AI adapter endpoint");

  const request = async ({ protocol, input, inputSchema, resultSchema }) => {
    const parsedInput = inputSchema.parse(input);
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ protocol, model: { identifier: modelIdentifier, version: modelVersion }, input: parsedInput }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch {
        if (attempt === 0) continue;
        throw new AiProviderError("AI_PROVIDER_UNAVAILABLE");
      }
      if (transientStatus.has(response.status) && attempt === 0) continue;
      if (!response.ok) throw new AiProviderError(response.status === 429 ? "AI_PROVIDER_RATE_LIMITED" : "AI_PROVIDER_UNAVAILABLE");
      break;
    }
    try {
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("oversized");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty response");
      const chunks = []; let bytesRead = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("oversized"); }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks, bytesRead).toString("utf8");
      const envelope = JSON.parse(text);
      if (envelope?.model?.identifier !== modelIdentifier || envelope?.model?.version !== modelVersion) throw new Error("model mismatch");
      const result = resultSchema.parse(envelope.result);
      return Object.freeze({ provider, modelIdentifier, modelVersion, result });
    } catch { throw new AiProviderError("AI_PROVIDER_INVALID_RESPONSE"); }
  };
  return Object.freeze({ provider, capabilities: Object.freeze({ transactionRiskAssessment: true, disputeAssistance: true }),
    assessTransactionRisk: (input) => request({ protocol: "trustbridge.ai.transaction-risk.v1", input, inputSchema: transactionRiskInputSchema, resultSchema: transactionRiskResultSchema }),
    assessDispute: (input) => request({ protocol: "trustbridge.ai.dispute-assistance.v1", input, inputSchema: disputeAssistanceInputSchema, resultSchema: disputeAssistanceResultSchema }),
  });
};

/** Deterministic adapter for tests. Never selected by normal application composition. */
export const createMockAiAdapter = ({ result, disputeResult, provider = "test-mock", modelIdentifier = "deterministic-test", modelVersion = "1" } = {}) => {
  const parsed = transactionRiskResultSchema.parse(result ?? { score: 12, riskLevel: "LOW", indicators: [], confidenceLevel: "LOW", recommendation: "NONE", summary: "No configured risk indicator was identified." });
  const parsedDispute = disputeAssistanceResultSchema.parse(disputeResult ?? { summary: "Review the dispute details and supporting evidence.", suggestedCategory: "OTHER", missingEvidenceCategories: [], reviewSteps: ["HUMAN_RESOLUTION_REQUIRED"], advisoryOnly: true });
  return Object.freeze({ provider, modelIdentifier, modelVersion, capabilities: Object.freeze({ transactionRiskAssessment: true, disputeAssistance: true }), async assessTransactionRisk(input) {
    const safeInput = transactionRiskInputSchema.parse(input);
    return Object.freeze({ provider, modelIdentifier, modelVersion, result: parsed, inputDataVersion: safeInput.inputDataVersion });
  }, async assessDispute(input) { const safeInput = disputeAssistanceInputSchema.parse(input); return Object.freeze({ provider, modelIdentifier, modelVersion, result: parsedDispute, inputDataVersion: safeInput.inputDataVersion }); } });
};
