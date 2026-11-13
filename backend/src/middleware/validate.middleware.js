import { ApiError } from "../utils/ApiError.js";

const requestSections = ["body", "query", "params"];
const invalidRequest = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");

// Validates only the request sections explicitly configured by a route.
// Parsed values are kept separate; this middleware never merges them into auth
// state or mutates Express's raw request sections.
export const validateRequest = (schemas = {}) => {
  const configured = requestSections.filter((section) => schemas[section] !== undefined);
  if (!configured.length || Object.keys(schemas).some((section) => !requestSections.includes(section))
    || configured.some((section) => typeof schemas[section]?.safeParse !== "function")) {
    throw new TypeError("At least one Zod request-section schema is required");
  }

  return (request, _response, next) => {
    const parsed = {};
    for (const section of configured) {
      const value = section === "body" ? (request.body ?? {}) : request[section];
      const result = schemas[section].safeParse(value);
      if (!result.success) return next(invalidRequest());
      parsed[section] = result.data;
    }

    request.validatedRequest = Object.assign(Object.create(null), request.validatedRequest ?? {}, parsed);
    return next();
  };
};
