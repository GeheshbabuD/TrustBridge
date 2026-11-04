import assert from "node:assert/strict";
import test from "node:test";
import { AuthServiceError, createAuthService } from "../../src/services/auth.service.js";

const input = {
  email: "buyer@example.test",
  password: "correct horse battery staple!",
  displayName: "Buyer Example",
};

const makeUser = (overrides = {}) => ({
  id: "user-id-1",
  email: input.email,
  role: "USER",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

test("registration hashes first and creates least-privileged User and Profile atomically", async () => {
  const order = [];
  const userData = [];
  const profileData = [];
  let transactionCount = 0;
  const user = makeUser();
  const prisma = {
    $transaction: async (callback) => {
      transactionCount += 1;
      return callback({
        user: {
          create: async ({ data }) => {
            order.push("user.create");
            userData.push(data);
            return user;
          },
        },
        profile: {
          create: async ({ data }) => {
            order.push("profile.create");
            profileData.push(data);
            return { displayName: data.displayName ?? null };
          },
        },
      });
    },
  };
  const service = createAuthService({
    getClient: async () => prisma,
    hash: async (password) => {
      order.push("hash");
      assert.equal(password, input.password);
      return "bcrypt-test-hash";
    },
  });

  const result = await service.register(input);

  assert.deepEqual(order, ["hash", "user.create", "profile.create"]);
  assert.equal(transactionCount, 1);
  assert.deepEqual(userData, [{
    email: input.email,
    passwordHash: "bcrypt-test-hash",
    role: "USER",
    status: "ACTIVE",
  }]);
  assert.deepEqual(profileData, [{ userId: user.id, displayName: input.displayName }]);
  assert.deepEqual(result, {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    profile: { displayName: input.displayName },
  });
  assert.equal(JSON.stringify(result).includes("passwordHash"), false);
  assert.equal(JSON.stringify(result).includes("bcrypt-test-hash"), false);
  assert.equal(JSON.stringify(result).includes('"status"'), false);
  assert.equal(JSON.stringify(result).includes('"role"'), false);
});

test("registration translates Prisma unique errors into a safe conflict", async () => {
  const marker = "private-database-index-details";
  const service = createAuthService({
    getClient: async () => ({
      $transaction: async () => {
        throw Object.assign(new Error(marker), { code: "P2002", meta: { target: marker } });
      },
    }),
    hash: async () => "synthetic-hash",
  });

  await assert.rejects(service.register(input), (error) => {
    assert.ok(error instanceof AuthServiceError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "REGISTRATION_CONFLICT");
    assert.equal(error.message.includes(marker), false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  });
});

test("concurrent duplicate registrations are arbitrated by the database unique constraint", async () => {
  const registeredEmails = new Set();
  let nextId = 1;
  const prisma = {
    $transaction: async (callback) => callback({
      user: {
        create: async ({ data }) => {
          if (registeredEmails.has(data.email)) {
            throw Object.assign(new Error("unique violation"), { code: "P2002" });
          }
          registeredEmails.add(data.email);
          return makeUser({ id: `user-${nextId++}`, email: data.email });
        },
      },
      profile: { create: async ({ data }) => ({ displayName: data.displayName ?? null }) },
    }),
  };
  const service = createAuthService({ getClient: async () => prisma, hash: async () => "hash" });

  const results = await Promise.allSettled([service.register(input), service.register(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof AuthServiceError);
  assert.equal(rejected.reason.code, "REGISTRATION_CONFLICT");
  assert.equal(registeredEmails.size, 1);
});

test("login returns only the public projection after active-user password verification", async () => {
  const user = makeUser({
    passwordHash: "stored-bcrypt-hash",
    profile: { displayName: "Buyer Example" },
  });
  let lookup;
  let verified = false;
  const service = createAuthService({
    getClient: async () => ({ user: { findUnique: async (args) => { lookup = args; return user; } } }),
    verify: async (password, hash) => {
      assert.equal(password, input.password);
      assert.equal(hash, "stored-bcrypt-hash");
      verified = true;
      return true;
    },
    sessionService: { issueForUser: async (userId) => ({ accessToken: "access-token", refreshToken: "refresh-token", tokenType: "Bearer", issuedFor: userId }) },
  });

  const result = await service.login({ email: input.email, password: input.password });

  assert.equal(verified, true);
  assert.deepEqual(lookup.where, { email: input.email });
  assert.equal(lookup.select.passwordHash, true);
  assert.deepEqual(result.user.profile, { displayName: "Buyer Example" });
  assert.equal(result.accessToken, "access-token");
  assert.equal(result.refreshToken, "refresh-token");
  assert.equal(JSON.stringify(result).includes("passwordHash"), false);
  assert.equal(JSON.stringify(result).includes("stored-bcrypt-hash"), false);
  assert.equal(JSON.stringify(result).includes('"status"'), false);
  assert.equal(JSON.stringify(result).includes('"role"'), false);
});

test("unknown email, incorrect password and inactive account use one auth error", async () => {
  for (const scenario of ["unknown", "incorrect", "inactive"]) {
    const user = scenario === "unknown"
      ? null
      : makeUser({ status: scenario === "inactive" ? "SUSPENDED" : "ACTIVE", passwordHash: "hash" });
    const service = createAuthService({
      getClient: async () => ({ user: { findUnique: async () => user } }),
      verify: async () => scenario !== "incorrect",
    });

    await assert.rejects(service.login({ email: input.email, password: input.password }), (error) => {
      assert.ok(error instanceof AuthServiceError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, "INVALID_CREDENTIALS");
      assert.equal(error.message, "Email or password is incorrect");
      return true;
    });
  }
});

test("USER with active MFA receives a challenge and no normal tokens", async () => {
  const user = makeUser({ passwordHash: "hash", authVersion: 2, mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } });
  let challengeInput;
  let sessionCalls = 0;
  const expiresAt = new Date("2026-01-01T00:05:00Z");
  const service = createAuthService({
    getClient: async () => ({ user: { findUnique: async () => user } }), verify: async () => true,
    mfaService: { createLoginChallenge: async (input) => { challengeInput = input; return { challengeToken: "opaque-challenge", expiresAt }; } },
    sessionService: { issueForUser: async () => { sessionCalls += 1; return {}; } },
  });
  const result = await service.login(input);
  assert.deepEqual(challengeInput, { userId: user.id, authVersion: 2 });
  assert.deepEqual(result, { mfaRequired: true, challengeToken: "opaque-challenge", expiresAt });
  assert.equal(sessionCalls, 0);
  assert.equal(JSON.stringify(result).includes("accessToken"), false);
  assert.equal(JSON.stringify(result).includes("refreshToken"), false);
});

test("ADMIN with active MFA also receives a challenge; ADMIN without active MFA cannot log in", async () => {
  const create = (user) => createAuthService({
    getClient: async () => ({ user: { findUnique: async () => user } }), verify: async () => true,
    mfaService: { createLoginChallenge: async () => ({ challengeToken: "challenge", expiresAt: new Date() }) },
    sessionService: { issueForUser: async () => assert.fail("ADMIN must not receive a password-only session") },
  });
  const admin = makeUser({ role: "ADMIN", authVersion: 0, passwordHash: "hash", mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } });
  assert.equal((await create(admin).login(input)).mfaRequired, true);
  const unprotectedAdmin = makeUser({ role: "ADMIN", passwordHash: "hash", mfa: null });
  await assert.rejects(create(unprotectedAdmin).login(input), { code: "INVALID_CREDENTIALS" });
});

test("incorrect password cannot create an MFA challenge and client-supplied policy is ignored", async () => {
  const user = makeUser({ passwordHash: "hash", mfa: { enrollmentStatus: "ENABLED", enabledAt: new Date() } });
  let challenges = 0;
  const service = createAuthService({ getClient: async () => ({ user: { findUnique: async () => user } }), verify: async () => false,
    mfaService: { createLoginChallenge: async () => { challenges += 1; return {}; } }, });
  await assert.rejects(service.login({ ...input, role: "ADMIN", mfaEnabled: false }), { code: "INVALID_CREDENTIALS" });
  assert.equal(challenges, 0);
});

test("challenge verification issues a session only for persistence-verified account context", async () => {
  let issue;
  const service = createAuthService({
    mfaService: { verifyLoginChallenge: async ({ challengeToken, code }) => {
      assert.equal(challengeToken, "opaque"); assert.equal(code, "123456");
      return { userId: "user-1", authVersion: 7, assuranceLevel: "TOTP_VERIFIED", mfaVerifiedAt: new Date("2026-01-01T00:00:00Z") };
    } },
    sessionService: { issueForUser: async (userId, options) => { issue = { userId, options }; return { accessToken: "signed", refreshToken: "opaque-refresh" }; } },
  });
  assert.deepEqual(await service.verifyLoginChallenge({ challengeToken: "opaque", code: "123456" }), { accessToken: "signed", refreshToken: "opaque-refresh" });
  assert.deepEqual(issue, { userId: "user-1", options: { expectedAuthVersion: 7, mfaVerifiedAt: new Date("2026-01-01T00:00:00Z"), assuranceLevel: "TOTP_VERIFIED" } });
});

test("recovery-code login issues only recovery assurance and does not invent TOTP time", async () => {
  let issued;
  const service = createAuthService({
    mfaService: { verifyLoginChallenge: async () => ({ userId: "user-1", authVersion: 7, assuranceLevel: "RECOVERY_CODE_VERIFIED", mfaVerifiedAt: null }) },
    sessionService: { issueForUser: async (userId, options) => { issued = { userId, options }; return { accessToken: "signed", refreshToken: "opaque" }; } },
  });
  await service.verifyLoginChallenge({ challengeToken: "opaque", code: "a".repeat(32) });
  assert.deepEqual(issued, { userId: "user-1", options: { expectedAuthVersion: 7, mfaVerifiedAt: null, assuranceLevel: "RECOVERY_CODE_VERIFIED" } });
});

test("authentication service fails closed for unknown assurance returned by verifier", async () => {
  const service = createAuthService({
    mfaService: { verifyLoginChallenge: async () => ({ userId: "user-1", authVersion: 7, assuranceLevel: "UNKNOWN", mfaVerifiedAt: null }) },
    sessionService: { issueForUser: async () => { throw new Error("must not issue"); } },
  });
  await assert.rejects(service.verifyLoginChallenge({ challengeToken: "opaque", code: "123456" }), { code: "INVALID_MFA_CHALLENGE" });
});
