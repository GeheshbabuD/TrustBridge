import { ApiError } from "../utils/ApiError.js";
import { paymentAttemptIdSchema, paymentCallbackSchema, paymentIdempotencyKeySchema, webhookProviderSchema } from "../validators/payment.validator.js";

const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");

export const createPaymentController = ({ paymentService }) => ({
  initiate: async (request, response, next) => {
    const key = paymentIdempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!key.success || !paymentAttemptIdSchema.safeParse(request.params.transactionId).success
      || !request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length) return next(invalid());
    try {
      const result = await paymentService.initiate({ auth: request.auth, transactionId: request.params.transactionId, idempotencyKey: key.data, requestId: request.requestId });
      return response.status(202).json({ success: true, message: "Payment attempt accepted", data: result });
    } catch (error) { return next(error); }
  },
  getAttempt: async (request, response, next) => {
    if (!paymentAttemptIdSchema.safeParse(request.params.paymentAttemptId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Payment attempt", data: { paymentAttempt: await paymentService.getAttempt({ auth: request.auth, paymentAttemptId: request.params.paymentAttemptId }) } }); }
    catch (error) { return next(error); }
  },
  verifyCallback: async (request, response, next) => {
    const body = paymentCallbackSchema.safeParse(request.body);
    if (!body.success || !paymentAttemptIdSchema.safeParse(request.params.paymentAttemptId).success) return next(invalid());
    try {
      const result = await paymentService.verifyPaymentCallback({ auth: request.auth, paymentAttemptId: request.params.paymentAttemptId, ...body.data, requestId: request.requestId });
      return response.status(200).json({ success: true, message: "Payment verification completed", data: result });
    } catch (error) { return next(error); }
  },
  webhook: async (request, response, next) => {
    const provider = webhookProviderSchema.safeParse(request.params.provider);
    if (!provider.success || !Buffer.isBuffer(request.rawBody)) return next(invalid());
    try {
      const result = await paymentService.receiveWebhook({ provider: provider.data, rawBody: request.rawBody, signature: request.get("x-razorpay-signature") ?? request.get("x-payment-signature"), eventId: request.get("x-razorpay-event-id"), requestId: request.requestId });
      return response.status(200).json({ success: true, message: "Webhook accepted", data: result });
    } catch (error) { return next(error); }
  },
});
