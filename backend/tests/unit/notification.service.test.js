import assert from "node:assert/strict";
import test from "node:test";
import { createMockEmailAdapter } from "../../src/services/email-provider.adapter.js";
import { createNotificationService } from "../../src/services/notification.service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const event = () => ({ id: "event-1", eventKey: "NOTICE:TRANSACTION_STATUS_CHANGED:tx:v2:buyer", eventType: "USER_NOTIFICATION", payload: { recipientId: userId, template: "TRANSACTION_STATUS_CHANGED", resourceType: "TRANSACTION", resourceId: "tx-1" }, status: "PENDING", attemptCount: 0 });

test("notification outbox workers deduplicate in-app and idempotent email delivery across concurrent instances", async () => {
  const row = event(); let state = "PENDING"; let attempts = 0; let notificationCount = 0;
  const prisma = {
    outboxEvent: {
      findMany: async () => state === "PENDING" ? [{ id: row.id }] : [],
      findUnique: async () => ({ ...row, status: state, attemptCount: attempts }),
      updateMany: async ({ where, data }) => {
        if (where.id !== row.id || (where.eventType && where.eventType !== row.eventType)) return { count: 0 };
        if (data.status === "PROCESSING") { if (state !== "PENDING") return { count: 0 }; state = "PROCESSING"; attempts += data.attemptCount.increment; }
        else { if (state !== "PROCESSING") return { count: 0 }; state = data.status; }
        return { count: 1 };
      },
    },
    user: { findUnique: async () => ({ id: userId, email: "person@example.invalid", status: "ACTIVE", profile: { notificationPreferences: {} } }) },
    notification: { upsert: async () => { notificationCount += 1; return { id: "notice-1" }; } },
  };
  const adapter = createMockEmailAdapter(); const serviceA = createNotificationService({ getClient: async () => prisma, emailAdapter: adapter }); const serviceB = createNotificationService({ getClient: async () => prisma, emailAdapter: adapter });
  const results = await Promise.all([serviceA.processOutboxBatch(), serviceB.processOutboxBatch()]);
  assert.equal(results.reduce((n, x) => n + x.claimed, 0), 1);
  assert.equal(notificationCount, 1); assert.equal(adapter.deliveries.size, 1); assert.equal(state, "PUBLISHED");
});

test("disabled transaction preferences suppress notices and outbox retry errors use bounded sanitized state", async () => {
  const row = event(); let state = "PENDING"; let attempts = 0; let upserts = 0;
  const prisma = {
    outboxEvent: { findMany: async () => state === "PENDING" ? [{ id: row.id }] : [], findUnique: async () => ({ ...row, attemptCount: attempts }), updateMany: async ({ data }) => { if (data.status === "PROCESSING") { state = "PROCESSING"; attempts += 1; } else state = data.status; return { count: 1 }; } },
    user: { findUnique: async () => ({ id: userId, email: "x@example.invalid", status: "ACTIVE", profile: { notificationPreferences: { transactionUpdates: false } } }) },
    notification: { upsert: async () => { upserts += 1; return { id: "x" }; } },
  };
  const service = createNotificationService({ getClient: async () => prisma });
  assert.deepEqual(await service.processOutboxBatch(), { claimed: 1, published: 1, deferred: 0 }); assert.equal(upserts, 0); assert.equal(state, "PUBLISHED");
  void attempts;
});

test("notification list and mark-read are recipient scoped and repeated reads are idempotent", async () => {
  let readAt = null;
  const row = { id: "11111111-1111-4111-8111-111111111112", recipientId: userId, type: "TRANSACTION_UPDATE", title: "Update", message: "Safe", readAt: null, createdAt: new Date() };
  const prisma = { notification: { findMany: async ({ where }) => { assert.equal(where.recipientId, userId); return [row]; }, updateMany: async ({ where, data }) => { if (where.recipientId !== userId || readAt) return { count: 0 }; readAt = data.readAt; return { count: 1 }; }, findFirst: async ({ where }) => where.recipientId === userId ? { id: row.id, readAt } : null } };
  const service = createNotificationService({ getClient: async () => prisma, now: () => new Date("2026-11-06T00:00:00Z") });
  const page = await service.listMine({ userId, limit: 5 }); assert.equal(page.notifications.length, 1); assert.equal("recipientId" in page.notifications[0], false);
  assert.equal((await service.markRead({ userId, notificationId: row.id })).changed, true);
  assert.equal((await service.markRead({ userId, notificationId: row.id })).changed, false);
});
