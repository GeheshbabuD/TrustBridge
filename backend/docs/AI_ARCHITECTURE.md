# AI Architecture

AI is advisory behind a modular service/provider adapter. Start with transparent rules when labeled data is insufficient; do not claim performance without measured evaluation.

Fraud/risk signals may include amount bands, failed payments, frequency and authorized dispute history; return bounded score/level/indicators/recommendation/version. Dispute analysis may summarize, categorize, identify missing evidence and suggest review steps; human decides. Transaction warnings are contextual. Support assistant retrieves only records authorized to the caller and abstains when unsupported.

Minimize/redact inputs; never send credentials/secrets. Use provider abstraction, timeouts, bounded retries, schema validation and provenance. Treat output as untrusted, defend against prompt injection and scope retrieval to authorized data. Persist model/version and human review under retention policy. High-risk recommendations enter a human review queue with reviewer identity, rationale, override and outcome; provide notice/appeal for adverse account decisions. AI cannot release/refund money, decide disputes or permanently ban users. Evaluate de-identified labeled sets, precision/recall, calibration, errors, bias, privacy, auth boundaries and abstention. Rule tests establish deterministic behavior, not predictive accuracy.

## Persistence boundary (TB-BE-024)

`RiskAssessment` stores transaction-scoped ruleset provenance, indicators, recommendation and optional human-review metadata. `AIAnalysis` stores optional transaction/dispute references, provider/model identifier and version, structured result and optional explainability JSON. Both reuse `AiReviewStatus`; multiple records per transaction/dispute are supported. JSON must contain only minimized, redacted, non-secret information. AI outputs are advisory and must never authorize financial operations or a final dispute outcome. Prisma cannot require that at least one AI subject FK is set or validate model-specific JSON; enforce both in services and focused tests.

## Deterministic transaction-risk baseline (TB-BE-091)

The baseline is independent of external AI configuration and uses only the minimized `transaction-risk.v1` snapshot already defined for TB-BE-090. Its policy version is `trustbridge-risk-baseline.v1`. The initial policy is deliberately limited to persisted workflow facts:

| Rule | Trigger | Category effect | Rationale |
|---|---|---|---|
| `ACTIVE_DISPUTE` | `disputes.open + disputes.underReview > 0` (first-count threshold: 1) | HIGH | An unresolved human dispute exists and warrants review; this is not a finding of wrongdoing or a financial instruction. |
| `PAYMENT_FAILURE_HISTORY` | `paymentAttempts.failed > 0` (first-count threshold: 1) | MEDIUM, unless `ACTIVE_DISPUTE` makes it HIGH | A persisted failed attempt is a review signal. One is used as the threshold because no evidence supports a higher cutoff; ordinary provider failures remain possible. |
| No rule | Both counts are zero | LOW | No signal in this limited baseline was observed; this is not a declaration that the transaction is safe. |

Active disputes take precedence over the payment-failure category. Captured, pending, cancelled, resolved and closed counts, amount, age and transaction status are recorded in the versioned input contract but do not independently raise risk: the project has no approved thresholds or evidence for those signals. Missing, invalid or inconsistent input produces `INSUFFICIENT_DATA`, not LOW. A source-version change before persistence rejects the assessment as stale. Every finding records its reason code, explanation and contributing input paths. These categories prioritize human review only; they are not calibrated probabilities, user/account decisions, transaction gates, or authorization for payment, escrow, refund, release, payout or dispute outcomes.

Each run appends a `RiskAssessment` with `rulesetVersion`, completion time, input contract version and source transaction version in structured indicator provenance. Provider/model analyses remain separate `AIAnalysis` records. Prior assessments are never overwritten. Baseline access uses the existing ADMIN, recent-TOTP and shared rate-limit boundary; assessment data is not returned to participants.

## Dispute assistance (TB-BE-092)

`POST /api/v1/admin/disputes/:disputeId/assistance` is an internal, administrator-only assist for disputes in `UNDER_REVIEW`. It requires the existing one-time `DISPUTE_REVIEW` TOTP step-up grant bound to that dispute, plus its own shared rate-limit bucket. The provider receives only dispute category/status/version/age, a bounded narrative after direct email/URL/phone/long-number redaction, and counts by allowlisted evidence category. It never receives evidence bytes, filenames, storage keys, uploader/participant identifiers, transaction identifiers or activity messages. The narrative remains user-supplied content and regex redaction cannot guarantee removal of names or all sensitive details; AI remains disabled by default and external use requires privacy/egress approval.

Outputs are strict, bounded advisory summary/category/missing-evidence/review-step fields. They cannot resolve, reject or modify a dispute, trigger escrow/payment/ledger actions or change account state. Results append as `AIAnalysis` with `disputeId`, `DISPUTE_ASSISTANCE`, provider/model provenance and source dispute version; any version/status change before persistence rejects the result. `PENDING` means human review remains required. Evidence categories and provider suggestions are not evidence, adjudication or authorization.
