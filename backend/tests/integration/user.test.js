import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { createUserRouter } from "../../src/routes/user.routes.js";
import { ApiError } from "../../src/utils/ApiError.js";

const userId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const publicUser = { id: userId, email: "person@example.test", role: "USER", status: "ACTIVE", createdAt: "2026-11-04T00:00:00.000Z", profile: { displayName: "Ada", preferences: {}, notificationPreferences: {} } };

const withServer = async (app, run) => {
  const server = app.listen(0);
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, "close"); }
};

test("user HTTP routes enforce authentication, allowlisted profile data, reauthentication and admin RBAC", async () => {
  const calls = [];
  const userService = {
    async getMe() { return publicUser; },
    async updateMe({ input }) { calls.push(["update", input]); return { ...publicUser, profile: { ...publicUser.profile, ...input } }; },
    async verifyCurrentPassword(input) { calls.push(["verify", input.userOnly]); return true; },
    async changePassword(input) { calls.push(["password", input]); return { changed: true, sessionsInvalidated: true }; },
    async deactivateMe() { return { deactivated: true, sessionsInvalidated: true }; },
    async listAdminUsers() { return { users: [publicUser], nextCursor: null }; },
    async getAdminUser(id) { return { ...publicUser, id }; },
    async updateUserStatus(input) { calls.push(["status", input]); return { user: { ...publicUser, id: input.targetUserId, status: input.status }, changed: true }; },
  };
  const authenticationMiddleware = (request, _response, next) => {
    const role = request.get("x-test-role");
    if (!role) return next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
    request.auth = { userId: role === "ADMIN" ? targetId : userId, role, status: "ACTIVE", authVersion: 3, sessionId: "session", mfaEnabled: false };
    return next();
  };
  const app = express();
  app.use(express.json());
  app.use(createUserRouter({ userService, authenticationMiddleware, stepUpAuthorizationMiddlewareFactory: ({ purpose }) => (request, _response, next) => { calls.push(["step-up", purpose]); next(); } }));
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const unauthorized = await fetch(`${base}/users/me`);
    assert.equal(unauthorized.status, 401);
    const own = await fetch(`${base}/users/me`, { headers: { "x-test-role": "USER" } });
    assert.equal(own.status, 200);
    const ownBody = await own.json();
    assert.equal("passwordHash" in ownBody.data.user, false);
    const injected = await fetch(`${base}/users/me`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-role": "USER" }, body: JSON.stringify({ role: "ADMIN" }) });
    assert.equal(injected.status, 400);
    const updated = await fetch(`${base}/users/me`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-role": "USER" }, body: JSON.stringify({ preferences: { locale: "fr" } }) });
    assert.equal(updated.status, 200);
    const password = await fetch(`${base}/users/me/password`, { method: "POST", headers: { "content-type": "application/json", "x-test-role": "USER" }, body: JSON.stringify({ currentPassword: "old password", newPassword: "brand new password" }) });
    assert.equal(password.status, 200);
    const userAdmin = await fetch(`${base}/admin/users`, { headers: { "x-test-role": "USER" } });
    assert.equal(userAdmin.status, 403);
    const status = await fetch(`${base}/admin/users/${userId}/status`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-role": "ADMIN" }, body: JSON.stringify({ status: "SUSPENDED", reasonCode: "SECURITY_REVIEW" }) });
    assert.equal(status.status, 200);
    assert.ok(calls.some(([kind, purpose]) => kind === "step-up" && purpose === "ADMIN_USER_STATUS_UPDATE"));
    assert.ok(calls.some(([kind]) => kind === "verify"));
    assert.equal(calls.find(([kind]) => kind === "password")[1].newPassword, "brand new password");
  });
});
