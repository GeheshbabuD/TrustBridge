import { ApiError } from "../utils/ApiError.js";
import { escrowIdempotencyKeySchema, escrowOperationSchema, escrowTransactionIdSchema } from "../validators/escrow.validator.js";

const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
export const createEscrowController = ({ escrowService }) => ({
  status: async (request, response, next) => {
    if (!escrowTransactionIdSchema.safeParse(request.params.transactionId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Escrow status", data: { escrow: await escrowService.getStatus({ auth: request.auth, transactionId: request.params.transactionId }) } }); }
    catch (error) { return next(error); }
  },
  release: async (request, response, next) => {
    const parsed = escrowOperationSchema.safeParse(request.body);
    const key = escrowIdempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!parsed.success || !key.success || parsed.data.reasonCode !== "BUYER_ACCEPTED_DELIVERY" || !escrowTransactionIdSchema.safeParse(request.params.transactionId).success) return next(invalid());
    try {
      const operation = await escrowService.authorizeRelease({ auth: request.auth, transactionId: request.params.transactionId, idempotencyKey: key.data, reasonCode: parsed.data.reasonCode, requestId: request.requestId });
      return response.status(operation.duplicate ? 200 : 202).json({ success: true, message: "Escrow release authorization recorded", data: { operation } });
    } catch (error) { return next(error); }
  },
  refund: async (request, response, next) => {
    const parsed = escrowOperationSchema.safeParse(request.body);
    const key = escrowIdempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!parsed.success || !key.success || parsed.data.reasonCode !== "ADMIN_RESOLVED_REFUND" || !escrowTransactionIdSchema.safeParse(request.params.transactionId).success) return next(invalid());
    try {
      const operation = await escrowService.authorizeRefund({ auth: request.auth, transactionId: request.params.transactionId, idempotencyKey: key.data, reasonCode: parsed.data.reasonCode, requestId: request.requestId });
      return response.status(operation.duplicate ? 200 : 202).json({ success: true, message: "Escrow refund authorization recorded", data: { operation } });
    } catch (error) { return next(error); }
  },
});
