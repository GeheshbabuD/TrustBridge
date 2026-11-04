import { ApiError } from "../utils/ApiError.js";
import { accountDeactivationSchema, adminUserListQuerySchema, adminUserStatusSchema, passwordChangeSchema, profileUpdateSchema } from "../validators/user.validator.js";
import { UserServiceError } from "../services/user.service.js";

const validationError = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
const forward = (error, next) => next(error instanceof UserServiceError ? new ApiError(error.statusCode, error.code, error.message) : error);

export const createUserController = ({ userService }) => ({
  getMe: async (request, response, next) => {
    try { return response.status(200).json({ success: true, message: "User profile", data: { user: await userService.getMe(request.auth.userId) } }); }
    catch (error) { return forward(error, next); }
  },
  updateMe: async (request, response, next) => {
    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Profile updated", data: { user: await userService.updateMe({ auth: request.auth, input: parsed.data }) } }); }
    catch (error) { return forward(error, next); }
  },
  changePassword: async (request, response, next) => {
    const parsed = passwordChangeSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Password changed; sign in again", data: await userService.changePassword({ auth: request.auth, ...parsed.data, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  deactivateMe: async (request, response, next) => {
    const parsed = accountDeactivationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Account deactivated", data: await userService.deactivateMe({ auth: request.auth, requestId: request.requestId }) }); }
    catch (error) { return forward(error, next); }
  },
  validateDeactivation: (request, _response, next) => {
    const parsed = accountDeactivationSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    request.validatedDeactivation = parsed.data;
    return next();
  },
  verifyDeactivationPassword: async (request, _response, next) => {
    try { await userService.verifyCurrentPassword({ auth: request.auth, currentPassword: request.validatedDeactivation.currentPassword, userOnly: true }); return next(); }
    catch (error) { return forward(error, next); }
  },
  validatePasswordChange: (request, _response, next) => {
    const parsed = passwordChangeSchema.safeParse(request.body);
    if (!parsed.success) return next(validationError());
    request.validatedPasswordChange = parsed.data;
    return next();
  },
  verifyPasswordChangePassword: async (request, _response, next) => {
    try { await userService.verifyCurrentPassword({ auth: request.auth, currentPassword: request.validatedPasswordChange.currentPassword }); return next(); }
    catch (error) { return forward(error, next); }
  },
  validateAdminStatus: (request, _response, next) => {
    const parsed = adminUserStatusSchema.safeParse(request.body);
    if (!parsed.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.userId ?? "")) return next(validationError());
    request.validatedAdminStatus = parsed.data;
    return next();
  },
  listAdminUsers: async (request, response, next) => {
    const parsed = adminUserListQuerySchema.safeParse(request.query);
    if (!parsed.success) return next(validationError());
    try { return response.status(200).json({ success: true, message: "Users", data: await userService.listAdminUsers(parsed.data) }); }
    catch (error) { return forward(error, next); }
  },
  getAdminUser: async (request, response, next) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.userId ?? "")) return next(validationError());
    try { return response.status(200).json({ success: true, message: "User", data: { user: await userService.getAdminUser(request.params.userId) } }); }
    catch (error) { return forward(error, next); }
  },
  updateAdminUserStatus: async (request, response, next) => {
    try { const result = await userService.updateUserStatus({ auth: request.auth, targetUserId: request.params.userId, ...request.validatedAdminStatus, requestId: request.requestId }); return response.status(200).json({ success: true, message: "User status updated", data: result }); }
    catch (error) { return forward(error, next); }
  },
});
