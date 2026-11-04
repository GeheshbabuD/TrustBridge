// Runtime provider selection is deliberately closed: a deployment must inject a
// reviewed adapter. This task does not select or simulate a production provider.
export const resolvePaymentAdapter = ({ adapter, provider }) => {
  const complete = adapter
    && typeof provider === "string"
    && adapter.providerId === provider
    && typeof adapter.createPaymentIntent === "function"
    && typeof adapter.verifyWebhook === "function"
    && typeof adapter.normalizeWebhook === "function"
    && adapter.capabilities?.idempotentIntentCreation === true
    && adapter.capabilities?.signedWebhooks === true
    && (adapter.capabilities?.statusLookup !== true || typeof adapter.fetchPaymentStatus === "function");
  if (complete) return adapter;
  throw new Error("PAYMENT_ADAPTER_UNAVAILABLE");
};
