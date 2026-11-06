import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { createNotificationRouter } from "../../src/routes/notification.routes.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

const userId = "11111111-1111-4111-8111-111111111111"; const otherId = "22222222-2222-4222-8222-222222222222"; const notificationId = "33333333-3333-4333-8333-333333333333";
test("notification HTTP API is authenticated, recipient-scoped and safely serialized", async (t) => {
  const calls = []; const now = new Date();
  const app = express();
  app.use((req, _res, next) => { const other = req.get("x-test-user") === "other"; req.auth = { userId: other ? otherId : userId, status: "ACTIVE", authVersion: 0 }; next(); });
  const service = { async listMine(input) { calls.push(["list", input]); return { notifications: [{ id: notificationId, type: "TRANSACTION_UPDATE", title: "Update", message: "Safe", readAt: null, createdAt: now }], nextCursor: null }; }, async markRead(input) { calls.push(["read", input]); return { id: input.notificationId, readAt: now, changed: true }; } };
  app.use(createNotificationRouter({ authenticationMiddleware: (_req, _res, next) => next(), notificationService: service, getClient: async () => ({ notification: { findUnique: async () => ({ id: notificationId, recipientId: userId }) } }) })); app.use(errorHandler);
  const server = app.listen(0); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const list = await fetch(`${base}/notifications?limit=10`); assert.equal(list.status, 200); const body = await list.json(); assert.equal(body.data.notifications[0].id, notificationId); assert.equal("recipientId" in body.data.notifications[0], false);
  const read = await fetch(`${base}/notifications/${notificationId}/read`, { method: "PATCH" }); assert.equal(read.status, 200); assert.equal(calls.find(([kind]) => kind === "read")[1].userId, userId);
  const denied = await fetch(`${base}/notifications/${notificationId}/read`, { method: "PATCH", headers: { "x-test-user": "other" } }); assert.equal(denied.status, 404);
  const invalid = await fetch(`${base}/notifications?limit=999`); assert.equal(invalid.status, 400);
});
