import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const modelBlock = (name) => {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `Expected ${name} model in canonical Prisma schema`);
  return match[1];
};

test("user identity fields use UUID, unique canonical email, hash-only credential storage and timestamps", () => {
  const user = modelBlock("User");
  assert.match(user, /id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/);
  assert.match(user, /email\s+String\s+@unique\(map: "users_email_key"\)\s+@db\.VarChar\(320\)/);
  assert.match(user, /passwordHash\s+String\s+@map\("password_hash"\)/);
  assert.doesNotMatch(user, /password\s+String/);
  assert.match(user, /role\s+UserRole\s+@default\(USER\)/);
  assert.match(user, /status\s+UserStatus\s+@default\(ACTIVE\)/);
  assert.match(user, /createdAt\s+DateTime\s+@default\(now\(\)\)/);
  assert.match(user, /updatedAt\s+DateTime\s+@default\(now\(\)\)\s+@updatedAt/);
});

test("profile is one-to-one, contains minimal non-sensitive profile data and restricts user deletion", () => {
  const user = modelBlock("User");
  const profile = modelBlock("Profile");
  assert.match(user, /profile\s+Profile\?/);
  assert.match(profile, /userId\s+String\s+@unique\(map: "profiles_user_id_key"\)/);
  assert.match(profile, /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict, onUpdate: Cascade\)/);
  assert.match(profile, /displayName\s+String\?/);
  assert.doesNotMatch(profile, /password|payment|evidence|token/i);
  assert.match(profile, /createdAt\s+DateTime/);
  assert.match(profile, /updatedAt\s+DateTime/);
});

test("account and participant role enums remain separate", () => {
  assert.match(schema, /enum UserRole\s*\{[\s\S]*?USER[\s\S]*?ADMIN[\s\S]*?\}/);
  assert.match(schema, /enum ParticipantRole\s*\{[\s\S]*?BUYER[\s\S]*?SELLER[\s\S]*?\}/);
});
