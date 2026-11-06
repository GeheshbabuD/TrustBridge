/** Provider-neutral email interface. Production adapters must enforce idempotencyKey at the provider boundary. */
export const createDisabledEmailAdapter = () => Object.freeze({ enabled: false, idempotent: true, async send() { return { accepted: false, disabled: true }; } });

/** Deterministic test adapter; it performs no network operation. */
export const createMockEmailAdapter = ({ fail = false } = {}) => {
  const deliveries = new Map();
  return Object.freeze({
    enabled: true,
    idempotent: true,
    async send({ to, subject, text, idempotencyKey }) {
      if (fail) throw new Error("MOCK_EMAIL_FAILURE");
      if (!idempotencyKey || !to || !subject || !text) throw new TypeError("Invalid email message");
      const duplicate = deliveries.has(idempotencyKey);
      if (!duplicate) deliveries.set(idempotencyKey, { to, subject, text });
      return { accepted: true, duplicate };
    },
    get deliveries() { return new Map(deliveries); },
  });
};
