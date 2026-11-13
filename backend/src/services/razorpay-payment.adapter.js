import { createHmac, timingSafeEqual } from "node:crypto";

const API_ROOT = "https://api.razorpay.com";
const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const safeMinor = (value) => {
  try {
    const amount = BigInt(value);
    return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
  } catch { return null; }
};
const signatureMatches = (secret, message, signature) => {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", secret).update(message).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const safeError = () => new Error("RAZORPAY_OPERATION_UNAVAILABLE");

/** Razorpay's documented REST adapter. Live calls are disabled unless explicitly enabled. */
export const createRazorpayPaymentAdapter = ({
  apiKey, apiSecret, webhookSecret, enabled = false, routeEnabled = false,
  refundsEnabled = false,
  fetchImpl = globalThis.fetch, timeoutMs = 8000,
  authorizeRefund = async () => false, authorizeRoute = async () => false,
} = {}) => {
  const request = async (path, { method = "GET", body, headers = {} } = {}) => {
    if (!enabled || typeof apiKey !== "string" || !apiKey || typeof apiSecret !== "string" || !apiSecret
      || typeof fetchImpl !== "function") throw safeError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_ROOT}${path}`, {
        method, signal: controller.signal,
        headers: {
          authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
          accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || typeof data !== "object") throw safeError();
      return data;
    } catch { throw safeError(); } finally { clearTimeout(timer); }
  };
  const findOrderByReceipt = async (receipt, amount, currency) => {
    const query = new URLSearchParams({ receipt, count: "100" });
    const response = await request(`/v1/orders?${query}`);
    if (!Array.isArray(response.items)) throw safeError();
    const rows = response.items.filter((order) => order.receipt === receipt);
    if (rows.length > 1) throw safeError();
    if (!rows.length) return null;
    const order = rows[0];
    if (order.amount !== amount || order.currency !== currency || typeof order.id !== "string" || !identifier.test(order.id)) throw safeError();
    return order.id;
  };
  const requireRouteAuthorization = async (operation, context) => {
    if (!routeEnabled || await authorizeRoute({ operation, ...context }) !== true) throw safeError();
  };
  const requireRefundAuthorization = async (context) => {
    if (!refundsEnabled || await authorizeRefund(context) !== true) throw safeError();
  };

  const adapter = {
    providerId: "razorpay",
    capabilities: Object.freeze({ idempotentIntentCreation: true, signedWebhooks: true, statusLookup: true }),
    getCheckoutConfiguration() {
      if (!enabled || !identifier.test(apiKey ?? "")) throw safeError();
      // Razorpay's key ID is intentionally public checkout configuration. The
      // API secret and webhook secret are never returned by this method.
      return Object.freeze({ key: apiKey });
    },
    async createPaymentIntent({ attemptId, amountMinor, currency }) {
      const amount = safeMinor(amountMinor);
      if (!identifier.test(attemptId) || amount === null || currency !== "INR") throw safeError();
      const receipt = attemptId;
      const existing = await findOrderByReceipt(receipt, amount, currency);
      if (existing) return { providerReference: existing, status: "PENDING" };
      try {
        const created = await request("/v1/orders", { method: "POST", body: { amount, currency, receipt } });
        if (typeof created.id !== "string" || !identifier.test(created.id) || created.amount !== amount || created.currency !== currency || created.receipt !== receipt) throw safeError();
        return { providerReference: created.id, status: "PENDING" };
      } catch {
        // The POST may have reached Razorpay before a timeout. Resolve by the stable unique receipt.
        const recovered = await findOrderByReceipt(receipt, amount, currency).catch(() => null);
        if (recovered) return { providerReference: recovered, status: "PENDING" };
        throw safeError();
      }
    },
    verifyPaymentSignature({ orderId, paymentId, signature }) {
      if (!identifier.test(orderId ?? "") || !identifier.test(paymentId ?? "") || !apiSecret) return false;
      return signatureMatches(apiSecret, `${orderId}|${paymentId}`, signature);
    },
    async fetchPaymentDetails({ paymentId }) {
      if (!identifier.test(paymentId ?? "")) throw safeError();
      const data = await request(`/v1/payments/${encodeURIComponent(paymentId)}`);
      if (data.id !== paymentId || typeof data.order_id !== "string" || !identifier.test(data.order_id)
        || !Number.isSafeInteger(data.amount) || data.amount < 1 || data.currency !== "INR"
        || !["created", "authorized", "captured", "refunded", "failed"].includes(data.status)) throw safeError();
      return { paymentId, orderId: data.order_id, amountMinor: String(data.amount), currency: data.currency, status: data.status };
    },
    verifyWebhook({ rawBody, signature }) {
      if (!Buffer.isBuffer(rawBody) || !webhookSecret) return false;
      return signatureMatches(webhookSecret, rawBody, signature);
    },
    normalizeWebhook({ rawBody, headers = {} }) {
      let body;
      try { body = JSON.parse(rawBody.toString("utf8")); } catch { return null; }
      const eventId = headers.eventId;
      const eventType = body?.event;
      const payment = body?.payload?.payment?.entity;
      const order = body?.payload?.order?.entity;
      let providerReference;
      let amount;
      let currency;
      let outcome = "PENDING";
      if (eventType === "order.paid" && order) {
        providerReference = order.id; amount = order.amount_paid; currency = order.currency; outcome = "CAPTURED";
      } else if (["payment.captured", "payment.authorized", "payment.failed"].includes(eventType) && payment) {
        providerReference = payment.order_id; amount = payment.amount; currency = payment.currency;
        if (eventType === "payment.captured") outcome = "CAPTURED";
        // A failed payment attempt does not prove its order can never later be paid.
      }
      if (typeof eventId !== "string" || !providerReference || !identifier.test(providerReference)
        || !Number.isSafeInteger(amount) || amount < 1 || currency !== "INR") return null;
      return { eventId, providerAccountScope: "default", eventType, providerReference, ...(payment?.id && identifier.test(payment.id) ? { paymentReference: payment.id } : {}), outcome,
        amountMinor: String(amount), currency, final: false, noCapture: false,
        providerOccurredAt: Number.isSafeInteger(body.created_at) ? new Date(body.created_at * 1000).toISOString() : null };
    },
    async fetchPaymentStatus({ providerReference, amountMinor, currency }) {
      if (!identifier.test(providerReference ?? "")) throw safeError();
      const result = await request(`/v1/orders/${encodeURIComponent(providerReference)}/payments`);
      if (!Array.isArray(result.items)) throw safeError();
      const captured = result.items.filter((payment) => payment.order_id === providerReference && payment.status === "captured");
      if (captured.length > 1) throw safeError();
      if (captured.length === 1) {
        const payment = captured[0];
        return { verified: true, providerReference, paymentReference: payment.id, outcome: "CAPTURED", amountMinor: String(payment.amount), currency: payment.currency, final: false, noCapture: false };
      }
      return { verified: true, providerReference, outcome: "PENDING", amountMinor: String(amountMinor), currency, final: false, noCapture: false };
    },
    async createRefund({ paymentId, amountMinor, idempotencyKey, financialContext }) {
      await requireRefundAuthorization(financialContext);
      if (!identifier.test(paymentId ?? "") || !/^[A-Za-z0-9_-]{10,64}$/.test(idempotencyKey ?? "")) throw safeError();
      const amount = amountMinor === undefined ? undefined : safeMinor(amountMinor);
      if (amountMinor !== undefined && amount === null) throw safeError();
      const data = await request(`/v1/payments/${encodeURIComponent(paymentId)}/refund`, { method: "POST", headers: { "X-Refund-Idempotency": idempotencyKey }, body: amount === undefined ? {} : { amount } });
      if (typeof data.id !== "string" || !identifier.test(data.id) || data.payment_id !== paymentId
        || !Number.isSafeInteger(data.amount) || data.amount < 1 || (amount !== undefined && data.amount !== amount)
        || data.currency !== "INR"
        || !["pending", "processed", "failed"].includes(data.status)) throw safeError();
      return { refundId: data.id, paymentId, amountMinor: String(data.amount), currency: data.currency, status: data.status };
    },
    async fetchRefund({ paymentId, refundId }) {
      if (!identifier.test(paymentId ?? "") || !identifier.test(refundId ?? "")) throw safeError();
      const data = await request(`/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`);
      if (data.id !== refundId || data.payment_id !== paymentId || data.currency !== "INR" || !Number.isSafeInteger(data.amount) || data.amount < 1 || !["pending", "processed", "failed"].includes(data.status)) throw safeError();
      return { refundId, paymentId, status: data.status, amountMinor: String(data.amount), currency: data.currency };
    },
    async createRouteLinkedAccount({ payload, financialContext }) {
      await requireRouteAuthorization("ROUTE_LINKED_ACCOUNT", financialContext);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw safeError();
      const data = await request("/v2/accounts", { method: "POST", body: payload });
      if (typeof data.id !== "string" || !identifier.test(data.id) || data.type !== "route") throw safeError();
      return { accountId: data.id, status: data.status };
    },
    async createRouteTransfer({ paymentId, accountId, amountMinor, idempotencyKey, financialContext }) {
      await requireRouteAuthorization("ROUTE_TRANSFER", financialContext);
      const amount = safeMinor(amountMinor);
      if (!identifier.test(paymentId ?? "") || !identifier.test(accountId ?? "") || amount === null || !/^[A-Za-z0-9_-]{4,36}$/.test(idempotencyKey ?? "")) throw safeError();
      const data = await request(`/v1/payments/${encodeURIComponent(paymentId)}/transfers`, { method: "POST", headers: { "X-Transfer-Idempotency": idempotencyKey }, body: { transfers: [{ account: accountId, amount, currency: "INR" }] } });
      const transfer = data.items?.length === 1 ? data.items[0] : data;
      if (typeof transfer.id !== "string" || !identifier.test(transfer.id) || (transfer.recipient && transfer.recipient !== accountId)
        || (transfer.amount !== undefined && transfer.amount !== amount) || (transfer.currency !== undefined && transfer.currency !== "INR")) throw safeError();
      return { transferId: transfer.id, paymentId, accountId, amountMinor: String(amount), currency: "INR", status: transfer.transfer_status ?? transfer.status ?? "created" };
    },
    async fetchRouteTransfer({ transferId }) {
      if (!identifier.test(transferId ?? "")) throw safeError();
      const data = await request(`/v1/transfers/${encodeURIComponent(transferId)}`);
      const status = data.transfer_status ?? data.status;
      if (data.id !== transferId || !identifier.test(data.recipient ?? "") || !identifier.test(data.source ?? "") || !Number.isSafeInteger(data.amount) || data.amount < 1
        || data.currency !== "INR" || !["created", "pending", "processed", "failed", "reversed", "partially_reversed"].includes(status)
        || !["pending", "on_hold", "settled"].includes(data.settlement_status)) throw safeError();
      return { transferId, accountId: data.recipient, paymentId: data.source, amountMinor: String(data.amount), currency: data.currency, settlementStatus: data.settlement_status, onHold: data.on_hold === true, status };
    },
    async setRouteTransferHold({ transferId, onHold, onHoldUntil, financialContext }) {
      await requireRouteAuthorization("ROUTE_TRANSFER_HOLD", financialContext);
      if (!identifier.test(transferId ?? "") || typeof onHold !== "boolean" || (onHoldUntil !== undefined && !Number.isSafeInteger(onHoldUntil))) throw safeError();
      const data = await request(`/v1/transfers/${encodeURIComponent(transferId)}`, { method: "PATCH", body: { on_hold: onHold, ...(onHoldUntil === undefined ? {} : { on_hold_until: onHoldUntil }) } });
      if (data.id !== transferId) throw safeError();
      return { transferId, onHold: data.on_hold === true, status: data.transfer_status };
    },
    async reverseRouteTransfer({ transferId, amountMinor, financialContext }) {
      await requireRouteAuthorization("ROUTE_TRANSFER_REVERSAL", financialContext);
      const amount = safeMinor(amountMinor);
      if (!identifier.test(transferId ?? "") || amount === null) throw safeError();
      const data = await request(`/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { method: "POST", body: { amount } });
      if (typeof data.id !== "string" || !identifier.test(data.id)) throw safeError();
      return { reversalId: data.id, transferId, status: data.status };
    },
  };
  return Object.freeze(adapter);
};
