import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = await readFile(new URL("../../prisma/migrations/20261104120000_user_profile_preferences/migration.sql", import.meta.url), "utf8");
const profile = schema.match(/model Profile \{([\s\S]*?)\n\}/)?.[1] ?? "";

test("profile preferences have non-null JSONB defaults and additive migration", () => {
  assert.match(profile, /preferences\s+Json\s+@default\("\{\}"\)\s+@db\.JsonB/);
  assert.match(profile, /notificationPreferences\s+Json\s+@default\("\{\}"\)\s+@map\("notification_preferences"\)\s+@db\.JsonB/);
  assert.match(migration, /ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration, /ADD COLUMN "notification_preferences" JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.doesNotMatch(migration, /DROP|TRUNCATE|DELETE|UPDATE|RENAME/i);
});

test("public account operations do not define role or credential update fields in profile schema", () => {
  assert.doesNotMatch(profile, /passwordHash|role|status|token|secret/i);
  assert.match(schema, /enum UserStatus\s*\{[\s\S]*?ACTIVE[\s\S]*?SUSPENDED[\s\S]*?DEACTIVATED[\s\S]*?\}/);
});
