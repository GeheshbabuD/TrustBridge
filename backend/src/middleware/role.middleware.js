import { ApiError } from "../utils/ApiError.js";

export const USER_ROLES = Object.freeze(["USER", "ADMIN"]);
const roleSet = new Set(USER_ROLES);
const forbidden = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const authenticationRequired = () => new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");

export const requireRoles = (...permittedRoles) => {
  if (!permittedRoles.length || permittedRoles.some((role) => !roleSet.has(role))) {
    throw new TypeError("Authorization policy must list valid UserRole values");
  }
  const permitted = new Set(permittedRoles);
  return (request, _response, next) => {
    const auth = request.auth;
    if (!auth || typeof auth.userId !== "string" || !roleSet.has(auth.role)) {
      return next(authenticationRequired());
    }
    if (!permitted.has(auth.role)) return next(forbidden());
    return next();
  };
};

export const requireRole = (role) => requireRoles(role);
