import assert from "node:assert/strict";
import test from "node:test";
import { accountDeactivationSchema, adminUserListQuerySchema, adminUserStatusSchema, passwordChangeSchema, profileUpdateSchema } from "../../src/validators/user.validator.js";

test("profile updates accept only normalized display and allowlisted preferences", () => {
  assert.deepEqual(profileUpdateSchema.parse({ displayName: "  Ada  ", preferences: { locale: "en-us", timeZone: "US/Eastern" }, notificationPreferences: { transactionUpdates: false } }), {
    displayName: "Ada", preferences: { locale: "en-US", timeZone: "America/New_York" }, notificationPreferences: { transactionUpdates: false },
  });
  for (const value of [{ role: "ADMIN" }, { email: "evil@example.test" }, { preferences: { password: "secret" } }, { notificationPreferences: { securityAlerts: false } }, {}]) {
    assert.throws(() => profileUpdateSchema.parse(value));
  }
});

test("password and account lifecycle schemas require safe reauthentication", () => {
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "old password", newPassword: "new password long" }).success, true);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "same password", newPassword: "same password" }).success, false);
  assert.equal(accountDeactivationSchema.safeParse({ currentPassword: "password", confirmation: "DEACTIVATE" }).success, true);
  assert.equal(accountDeactivationSchema.safeParse({ currentPassword: "password", confirmation: "yes" }).success, false);
});

test("admin status and pagination schemas reject role mutation and unsafe bounds", () => {
  assert.deepEqual(adminUserStatusSchema.parse({ status: "SUSPENDED", reasonCode: "SECURITY_REVIEW" }), { status: "SUSPENDED", reasonCode: "SECURITY_REVIEW" });
  assert.equal(adminUserStatusSchema.safeParse({ status: "ACTIVE", role: "ADMIN", reasonCode: "OTHER" }).success, false);
  assert.deepEqual(adminUserListQuerySchema.parse({ limit: "20", status: "ACTIVE" }), { limit: 20, status: "ACTIVE" });
  assert.equal(adminUserListQuerySchema.safeParse({ limit: "1000" }).success, false);
});
