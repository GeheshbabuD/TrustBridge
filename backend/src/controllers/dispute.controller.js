import { ApiError } from "../utils/ApiError.js";
import { disputeCreateSchema, disputeIdempotencyKeySchema, disputeIdSchema, disputeResponseSchema, disputeResolutionSchema, transactionIdSchema } from "../validators/dispute.validator.js";

const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
const forward = (error, next) => next(error);
const createDisputeController = ({ disputeService }) => ({
  create: async (request, response, next) => {
    const body = disputeCreateSchema.safeParse(request.body); const key = disputeIdempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!body.success || !key.success || !transactionIdSchema.safeParse(request.params.transactionId).success) return next(invalid());
    try { const result = await disputeService.create({ auth: request.auth, transactionId: request.params.transactionId, input: body.data, idempotencyKey: key.data, requestId: request.requestId }); return response.status(result.duplicate ? 200 : 201).json({ success: true, message: "Dispute opened", data: result.dispute }); }
    catch (error) { return forward(error, next); }
  },
  get: async (request, response, next) => {
    if (!disputeIdSchema.safeParse(request.params.disputeId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Dispute details", data: await disputeService.get({ auth: request.auth, disputeId: request.params.disputeId }) }); }
    catch (error) { return forward(error, next); }
  },
  getForReview: async (request, response, next) => {
    if (!disputeIdSchema.safeParse(request.params.disputeId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Dispute review details", data: await disputeService.get({ auth: request.auth, disputeId: request.params.disputeId, adminReview: true, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  respond: async (request, response, next) => {
    const body = disputeResponseSchema.safeParse(request.body); if (!body.success || !disputeIdSchema.safeParse(request.params.disputeId).success) return next(invalid());
    try { return response.status(201).json({ success: true, message: "Dispute response recorded", data: await disputeService.respond({ auth: request.auth, disputeId: request.params.disputeId, message: body.data.message, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  uploadEvidence: async (request, response, next) => {
    if (!disputeIdSchema.safeParse(request.params.disputeId).success || !/^[A-Z][A-Z0-9_]{1,63}$/.test(request.get("x-evidence-category") ?? "")) return next(invalid());
    try { return response.status(201).json({ success: true, message: "Evidence stored", data: await disputeService.uploadEvidence({ auth: request.auth, disputeId: request.params.disputeId, body: request.body, contentType: request.get("content-type")?.split(";", 1)[0].toLowerCase(), filename: request.get("x-evidence-filename"), category: request.get("x-evidence-category"), requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  downloadEvidence: (adminReview = false) => async (request, response, next) => {
    if (!disputeIdSchema.safeParse(request.params.evidenceId).success) return next(invalid());
    try {
      const file = await disputeService.downloadEvidence({ auth: request.auth, evidenceId: request.params.evidenceId, adminReview, requestId: request.requestId });
      response.set("Content-Type", file.contentType); response.set("Content-Disposition", `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`); response.set("X-Content-Type-Options", "nosniff"); response.set("Cache-Control", "private, no-store");
      return response.status(200).send(file.body);
    } catch (error) { return forward(error, next); }
  },
  review: async (request, response, next) => {
    if (!disputeIdSchema.safeParse(request.params.disputeId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Dispute review started", data: await disputeService.startReview({ auth: request.auth, disputeId: request.params.disputeId, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  resolve: async (request, response, next) => {
    const body = disputeResolutionSchema.safeParse(request.body); if (!body.success || !disputeIdSchema.safeParse(request.params.disputeId).success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Dispute resolution recorded", data: await disputeService.resolve({ auth: request.auth, disputeId: request.params.disputeId, ...body.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
});
export { createDisputeController };
