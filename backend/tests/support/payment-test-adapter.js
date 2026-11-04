import { createHmac, timingSafeEqual } from "node:crypto";

const safeReference = /^[A-Za-z0-9._:-]{1,255}$/;

// Deterministic test-only adapter. Kept under tests/ so production composition
// cannot accidentally select it.
export const createDeterministicPaymentTestAdapter = ({ secret = "test-only-webhook-secret" } = {}) => Object.freeze({
  providerId: "trustbridge-test",
  capabilities: Object.freeze({ idempotentIntentCreation: true, signedWebhooks: true, statusLookup: true }),
  async createPaymentIntent({ attemptId, idempotencyKey }) {
    return { providerReference: `test_${attemptId}`, status: "PENDING", providerIdempotencyKey: idempotencyKey };
  },
  async verifyWebhook({ rawBody, signature }) {
    if (!Buffer.isBuffer(rawBody) || typeof signature !== "string") return null;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    let supplied;
    try { supplied = Buffer.from(signature, "hex"); } catch { return null; }
    return supplied.length === expected.length && timingSafeEqual(expected, supplied) ? true : null;
  },
  normalizeWebhook({ rawBody }) {
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch { return null; }
    if (!body || !safeReference.test(body.eventId) || !safeReference.test(body.providerReference)
      || !["CAPTURED", "FAILED", "CANCELLED", "PENDING"].includes(body.outcome)
      || typeof body.amountMinor !== "string" || !/^[1-9]\d{0,18}$/.test(body.amountMinor)
      || typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) return null;
    return Object.freeze({
      eventId: body.eventId,
      providerAccountScope: "default",
      eventType: `payment.${body.outcome.toLowerCase()}`,
      providerReference: body.providerReference,
      outcome: body.outcome,
      final: body.final === true,
      amountMinor: body.amountMinor,
      currency: body.currency,
      noCapture: body.noCapture === true,
      providerOccurredAt: Number.isFinite(Date.parse(body.occurredAt)) ? new Date(body.occurredAt).toISOString() : null,
    });
  },
  async fetchPaymentStatus() { return { outcome: "UNKNOWN" }; },
  signTestEvent(rawBody) { return createHmac("sha256", secret).update(rawBody).digest("hex"); },
});
