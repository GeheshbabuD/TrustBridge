import { z } from "zod";
import { disputeAssistanceParamsSchema, transactionRiskAssessmentParamsSchema } from "../validators/ai.validator.js";
import { ApiError } from "../utils/ApiError.js";

const emptyBodySchema = z.object({}).strict();
const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");

export const createAiController = ({ aiService }) => ({
  assessTransactionRisk: async (request, response, next) => {
    if (!transactionRiskAssessmentParamsSchema.safeParse(request.params).success || !emptyBodySchema.safeParse(request.body ?? {}).success) return next(invalid());
    try {
      const data = await aiService.assessTransactionRisk({ auth: request.auth, transactionId: request.params.transactionId, requestId: request.requestId });
      return response.status(201).json({ success: true, message: "Advisory risk assessment created", data });
    } catch (error) { return next(error); }
  },
  assessTransactionRiskBaseline: async (request, response, next) => {
    if (!transactionRiskAssessmentParamsSchema.safeParse(request.params).success || !emptyBodySchema.safeParse(request.body ?? {}).success) return next(invalid());
    try {
      const data = await aiService.assessTransactionRisk({ auth: request.auth, transactionId: request.params.transactionId, requestId: request.requestId });
      return response.status(201).json({ success: true, message: "Deterministic advisory risk baseline created", data });
    } catch (error) { return next(error); }
  },
  assessDispute: async (request, response, next) => {
    if (!disputeAssistanceParamsSchema.safeParse(request.params).success || !emptyBodySchema.safeParse(request.body ?? {}).success) return next(invalid());
    try {
      const data = await aiService.assessDispute({ auth: request.auth, disputeId: request.params.disputeId, requestId: request.requestId });
      return response.status(201).json({ success: true, message: "Advisory dispute assistance created", data });
    } catch (error) { return next(error); }
  },
});
