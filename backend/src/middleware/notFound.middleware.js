import { ApiError } from "../utils/ApiError.js";

export const notFoundHandler = (request, _response, next) => {
  next(new ApiError(404, "NOT_FOUND", "Route not found"));
};
