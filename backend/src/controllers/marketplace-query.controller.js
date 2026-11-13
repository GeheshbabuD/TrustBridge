import { ApiError } from "../utils/ApiError.js";
import { adminDisputeListQuerySchema, adminTransactionListQuerySchema, sellerLookupQuerySchema } from "../validators/marketplace-query.validator.js";

const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
export const createMarketplaceQueryController = ({ queryService }) => ({
  searchSellers: async (request, response, next) => {
    const query = sellerLookupQuerySchema.safeParse(request.query);
    if (!query.success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Sellers", data: await queryService.searchSellers(query.data) }); }
    catch (error) { return next(error); }
  },
  listAdminTransactions: async (request, response, next) => {
    const query = adminTransactionListQuerySchema.safeParse(request.query);
    if (!query.success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Transactions", data: await queryService.listAdminTransactions({ auth: request.auth, ...query.data }) }); }
    catch (error) { return next(error); }
  },
  listAdminDisputes: async (request, response, next) => {
    const query = adminDisputeListQuerySchema.safeParse(request.query);
    if (!query.success) return next(invalid());
    try { return response.status(200).json({ success: true, message: "Disputes", data: await queryService.listAdminDisputes({ auth: request.auth, ...query.data }) }); }
    catch (error) { return next(error); }
  },
});
