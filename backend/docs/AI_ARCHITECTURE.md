# AI Architecture

AI is advisory behind a modular service/provider adapter. Start with transparent rules when labeled data is insufficient; do not claim performance without measured evaluation.

Fraud/risk signals may include amount bands, failed payments, frequency and authorized dispute history; return bounded score/level/indicators/recommendation/version. Dispute analysis may summarize, categorize, identify missing evidence and suggest review steps; human decides. Transaction warnings are contextual. Support assistant retrieves only records authorized to the caller and abstains when unsupported.

Minimize/redact inputs; never send credentials/secrets. Use provider abstraction, timeouts, bounded retries, schema validation and provenance. Treat output as untrusted, defend against prompt injection and scope retrieval to authorized data. Persist model/version and human review under retention policy. High-risk recommendations enter a human review queue with reviewer identity, rationale, override and outcome; provide notice/appeal for adverse account decisions. AI cannot release/refund money, decide disputes or permanently ban users. Evaluate de-identified labeled sets, precision/recall, calibration, errors, bias, privacy, auth boundaries and abstention. Rule tests establish deterministic behavior, not predictive accuracy.

## Persistence boundary (TB-BE-024)

`RiskAssessment` stores transaction-scoped ruleset provenance, indicators, recommendation and optional human-review metadata. `AIAnalysis` stores optional transaction/dispute references, provider/model identifier and version, structured result and optional explainability JSON. Both reuse `AiReviewStatus`; multiple records per transaction/dispute are supported. JSON must contain only minimized, redacted, non-secret information. AI outputs are advisory and must never authorize financial operations or a final dispute outcome. Prisma cannot require that at least one AI subject FK is set or validate model-specific JSON; enforce both in services and focused tests.
