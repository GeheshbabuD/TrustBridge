import { ApiError } from "../utils/ApiError.js";
import { deliveryDecisionSchema, deliveryStartSchema, deliverySubmitSchema, idempotencyKeySchema, transactionCreateSchema, transactionHistoryQuerySchema, transactionInvitationCreateSchema, transactionInvitationResponseSchema, transactionListQuerySchema, transactionTermsDecisionSchema, transactionTermsProposalSchema, transactionTransitionSchema } from "../validators/transaction.validator.js";

const validationError = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
const forward = (error, next) => next(error);

export const createTransactionController = ({ transactionService, deliveryService }) => ({
  create: async (request, response, next) => {
    const input = transactionCreateSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(request.get("idempotency-key"));
    if (!input.success || !key.success) return next(validationError());
    try { return response.status(201).json({ success: true, message: "Transaction created", data: { transaction: await transactionService.create({ auth: request.auth, input: input.data, idempotencyKey: key.data, requestId: request.requestId }) } }); }
    catch (error) { return forward(error, next); }
  },
  list: async (request, response, next) => {
    const query = transactionListQuerySchema.safeParse(request.query);
    if (!query.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Transactions", data: await transactionService.listForUser({ userId: request.auth.userId, ...query.data }) }); }
    catch (error) { return forward(error, next); }
  },
  get: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Transaction", data: { transaction: await transactionService.getForParticipant({ transactionId: request.params.transactionId, userId: request.auth.userId }) } }); }
    catch (error) { return forward(error, next); }
  },
  history: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const query = transactionHistoryQuerySchema.safeParse(request.query);
    if (!query.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Transaction history", data: await transactionService.getHistory({ transactionId: request.params.transactionId, ...query.data }) }); }
    catch (error) { return forward(error, next); }
  },
  getTerms: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Transaction terms", data: await transactionService.getTerms({ transactionId: request.params.transactionId, userId: request.auth.userId }) }); }
    catch (error) { return forward(error, next); }
  },
  proposeTerms: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = transactionTermsProposalSchema.safeParse(request.body);
    if (!input.success) return next(validationError());
    try { return response.status(201).json({ success: true, message: "Terms version proposed", data: { termsVersion: await transactionService.proposeTerms({ auth: request.auth, transactionId: request.params.transactionId, input: input.data, requestId: request.requestId }) } }); }
    catch (error) { return forward(error, next); }
  },
  decideTerms: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = transactionTermsDecisionSchema.safeParse(request.body);
    if (!input.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Terms decision recorded", data: { termsVersion: await transactionService.decideTerms({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) } }); }
    catch (error) { return forward(error, next); }
  },
  createInvitation: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = transactionInvitationCreateSchema.safeParse(request.body);
    if (!input.success) return next(validationError());
    try { return response.status(201).json({ success: true, message: "Invitation issued", data: await transactionService.createInvitation({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  respondToInvitation: (decision) => async (request, response, next) => {
    const input = transactionInvitationResponseSchema.safeParse(request.body);
    if (!input.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Invitation response recorded", data: await transactionService.respondToInvitation({ auth: request.auth, ...input.data, decision, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  transition: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = transactionTransitionSchema.safeParse(request.body);
    if (!input.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Transaction status updated", data: { transaction: await transactionService.transition({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) } }); }
    catch (error) { return forward(error, next); }
  },
  startWork: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = deliveryStartSchema.safeParse(request.body); if (!input.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Work started", data: await deliveryService.startWork({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  submitDelivery: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = deliverySubmitSchema.safeParse(request.body); if (!input.success) return next(validationError());
    try { return response.status(201).json({ success: true, message: "Delivery submitted", data: await deliveryService.submitDelivery({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  deliveryHistory: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Delivery history", data: await deliveryService.getHistory({ auth: request.auth, transactionId: request.params.transactionId }) }); }
    catch (error) { return forward(error, next); }
  },
  decideDelivery: async (request, response, next) => {
    if (!isUuid(request.params.transactionId)) return next(validationError());
    const input = deliveryDecisionSchema.safeParse(request.body); if (!input.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Delivery decision recorded", data: await deliveryService.decideDelivery({ auth: request.auth, transactionId: request.params.transactionId, ...input.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  uploadDeliveryEvidence: async (request, response, next) => {
    if (!isUuid(request.params.transactionId) || !isUuid(request.params.deliveryId) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(request.get("x-evidence-category") ?? "")) return next(validationError());
    try { return response.status(201).json({ success: true, message: "Delivery evidence stored", data: await deliveryService.uploadEvidence({ auth: request.auth, transactionId: request.params.transactionId, deliveryId: request.params.deliveryId, body: request.body, contentType: request.get("content-type")?.split(";", 1)[0].toLowerCase(), filename: request.get("x-evidence-filename"), category: request.get("x-evidence-category"), requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  downloadDeliveryEvidence: async (request, response, next) => {
    if (!isUuid(request.params.evidenceId)) return next(validationError());
    try { const file = await deliveryService.downloadEvidence({ auth: request.auth, evidenceId: request.params.evidenceId, requestId: request.requestId }); response.set("Content-Type", file.contentType); response.set("Content-Disposition", `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`); response.set("X-Content-Type-Options", "nosniff"); response.set("Cache-Control", "private, no-store"); return response.status(200).send(file.body); }
    catch (error) { return forward(error, next); }
  },
});

const isUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
