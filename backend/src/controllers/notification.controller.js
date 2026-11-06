import { ApiError } from "../utils/ApiError.js";
import { notificationIdSchema, notificationListQuerySchema } from "../validators/notification.validator.js";

const invalid = () => new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
export const createNotificationController = ({ notificationService }) => ({
  listMine: async (req, res, next) => {
    const parsed = notificationListQuerySchema.safeParse(req.query); if (!parsed.success) return next(invalid());
    try { return res.status(200).json({ success: true, message: "Notifications", data: await notificationService.listMine({ userId: req.auth.userId, ...parsed.data }) }); }
    catch (error) { return next(error); }
  },
  markRead: async (req, res, next) => {
    if (!notificationIdSchema.safeParse(req.params.notificationId).success) return next(invalid());
    try { return res.status(200).json({ success: true, message: "Notification updated", data: await notificationService.markRead({ userId: req.auth.userId, notificationId: req.params.notificationId }) }); }
    catch (error) { return next(error); }
  },
});
