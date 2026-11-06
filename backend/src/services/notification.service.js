import { randomUUID } from "node:crypto";
import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";
import { NOTIFICATION_TEMPLATES, serializeNotification } from "../models/notification.model.js";
import { createDisabledEmailAdapter } from "./email-provider.adapter.js";

const unavailable = () => new ApiError(503, "NOTIFICATION_UNAVAILABLE", "Notification service is temporarily unavailable");
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");

export const createNotificationService = ({ getClient = getPrismaClient, emailAdapter = createDisabledEmailAdapter(), now = () => new Date() } = {}) => {
  const listMine = async ({ userId, cursor, limit = 25 }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed");
    try {
      const rows = await (await getClient()).notification.findMany({ where: { recipientId: userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const hasMore = rows.length > limit; const selected = rows.slice(0, limit);
      return { notifications: selected.map(serializeNotification), nextCursor: hasMore ? selected.at(-1)?.id ?? null : null };
    } catch { throw unavailable(); }
  };
  const markRead = async ({ userId, notificationId }) => {
    try {
      const stamp = now(); const prisma = await getClient();
      const changed = await prisma.notification.updateMany({ where: { id: notificationId, recipientId: userId, readAt: null }, data: { readAt: stamp } });
      if (changed.count !== 1) {
        const existing = await prisma.notification.findFirst({ where: { id: notificationId, recipientId: userId }, select: { id: true, readAt: true } });
        if (!existing) throw notFound();
        return { id: existing.id, readAt: existing.readAt, changed: false };
      }
      return { id: notificationId, readAt: stamp, changed: true };
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const processOutboxBatch = async ({ limit = 20, leaseMs = 60_000 } = {}) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid notification batch limit");
    const prisma = await getClient(); const stamp = now();
    const candidates = await prisma.outboxEvent.findMany({ where: { eventType: "USER_NOTIFICATION", OR: [{ status: "PENDING", nextAttemptAt: { lte: stamp } }, { status: "PROCESSING", leaseExpiresAt: { lte: stamp } }] }, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: limit, select: { id: true } });
    let claimed = 0; let published = 0; let deferred = 0;
    for (const { id } of candidates) {
      const owner = randomUUID(); const claimAt = now();
      const claim = await prisma.outboxEvent.updateMany({ where: { id, eventType: "USER_NOTIFICATION", OR: [{ status: "PENDING", nextAttemptAt: { lte: claimAt } }, { status: "PROCESSING", leaseExpiresAt: { lte: claimAt } }] }, data: { status: "PROCESSING", leaseOwner: owner, claimedAt: claimAt, leaseExpiresAt: new Date(claimAt.getTime() + leaseMs), attemptCount: { increment: 1 } } });
      if (claim.count !== 1) continue;
      claimed += 1;
      const event = await prisma.outboxEvent.findUnique({ where: { id } });
      try {
        const payload = event?.payload;
        const template = payload && NOTIFICATION_TEMPLATES[payload.template];
        if (!event || !template || typeof payload.recipientId !== "string" || typeof payload.resourceId !== "string") throw new Error("INVALID_NOTIFICATION_EVENT");
        const recipient = await prisma.user.findUnique({ where: { id: payload.recipientId }, select: { id: true, email: true, status: true, profile: { select: { notificationPreferences: true } } } });
        const preference = recipient?.profile?.notificationPreferences?.[template.category];
        const enabled = recipient?.status === "ACTIVE" && preference !== false;
        if (enabled) {
          const notification = await prisma.notification.upsert({ where: { recipientId_dedupeKey: { recipientId: recipient.id, dedupeKey: event.eventKey } }, create: { recipientId: recipient.id, type: template.type, title: template.title, message: template.message, dedupeKey: event.eventKey }, update: {}, select: { id: true } });
          if (emailAdapter.enabled === true && typeof emailAdapter.send === "function") {
            if (emailAdapter.idempotent !== true) throw new Error("EMAIL_IDEMPOTENCY_UNAVAILABLE");
            const sent = await emailAdapter.send({ to: recipient.email, subject: template.title, text: template.message, idempotencyKey: event.eventKey });
            if (sent?.accepted !== true) throw new Error("EMAIL_NOT_ACCEPTED");
          }
          void notification;
        }
        const completed = await prisma.outboxEvent.updateMany({ where: { id, status: "PROCESSING", leaseOwner: owner }, data: { status: "PUBLISHED", publishedAt: now(), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null } });
        if (completed.count !== 1) deferred += 1; else published += 1;
      } catch {
        const attempts = event?.attemptCount ?? 1; const terminal = attempts >= 8;
        const delay = Math.min(60 * 60_000, 1000 * (2 ** Math.min(attempts, 12)));
        await prisma.outboxEvent.updateMany({ where: { id, status: "PROCESSING", leaseOwner: owner }, data: { status: terminal ? "FAILED" : "PENDING", nextAttemptAt: new Date(now().getTime() + delay), leaseOwner: null, leaseExpiresAt: null, lastErrorCode: "NOTIFICATION_DELIVERY_FAILED" } });
        deferred += 1;
      }
    }
    return { claimed, published, deferred };
  };

  return Object.freeze({ listMine, markRead, processOutboxBatch });
};
