import { getPrismaClient } from "../config/db.js";
import { hashPassword, verifyPassword } from "./password.service.js";
import { createSessionService } from "./session.service.js";
import { createMfaService, MfaServiceError } from "./mfa.service.js";
import { AuthServiceError } from "../utils/ApiError.js";

const publicUserSelect = Object.freeze({
  id: true,
  email: true,
  createdAt: true,
});

export { AuthServiceError };

const registrationConflict = () =>
  new AuthServiceError(409, "REGISTRATION_CONFLICT", "Unable to create account with those details");

const invalidCredentials = () =>
  new AuthServiceError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");

const publicUser = (user, profile) => ({
  id: user.id,
  email: user.email,
  createdAt: user.createdAt,
  profile: { displayName: profile?.displayName ?? null },
});

export const createAuthService = ({
  getClient = getPrismaClient,
  hash = hashPassword,
  verify = verifyPassword,
  sessionService = createSessionService(),
  mfaService,
} = {}) => {
  const getMfaService = () => mfaService ?? createMfaService();
  const register = async ({ email, password, displayName }) => {
    // Expensive hashing is completed before opening a database transaction.
    const passwordHash = await hash(password);
    const prisma = await getClient();

    try {
      return await prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            email,
            passwordHash,
            role: "USER",
            status: "ACTIVE",
          },
          select: publicUserSelect,
        });

        const profile = await transaction.profile.create({
          data: {
            userId: user.id,
            ...(displayName === undefined ? {} : { displayName }),
          },
          select: { displayName: true },
        });

        return publicUser(user, profile);
      });
    } catch (error) {
      // The database unique constraint arbitrates duplicate/concurrent emails.
      if (error?.code === "P2002") throw registrationConflict();
      throw error;
    }
  };

  const login = async ({ email, password }) => {
    const prisma = await getClient();
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        ...publicUserSelect,
        status: true,
        role: true,
        authVersion: true,
        passwordHash: true,
        mfa: { select: { enrollmentStatus: true, enabledAt: true } },
        profile: { select: { displayName: true } },
      },
    });

    const passwordMatches = user ? await verify(password, user.passwordHash) : false;
    if (!user || !passwordMatches || user.status !== "ACTIVE") {
      throw invalidCredentials();
    }

    const mfaEnabled = user.mfa?.enrollmentStatus === "ENABLED" && Boolean(user.mfa.enabledAt);
    if (user.role === "ADMIN" && !mfaEnabled) throw invalidCredentials();
    if (mfaEnabled) {
      try {
        const challenge = await getMfaService().createLoginChallenge({ userId: user.id, authVersion: user.authVersion });
        return { mfaRequired: true, ...challenge };
      } catch (error) {
        if (error instanceof MfaServiceError && error.statusCode === 401) throw invalidCredentials();
        throw new AuthServiceError(503, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable");
      }
    }

    const tokens = await sessionService.issueForUser(user.id, { expectedAuthVersion: Number.isSafeInteger(user.authVersion) ? user.authVersion : 0 });
    return { user: publicUser(user, user.profile), ...tokens };
  };

  const verifyLoginChallenge = async ({ challengeToken, code }) => {
    let verified;
    try { verified = await getMfaService().verifyLoginChallenge({ challengeToken, code }); }
    catch { throw new AuthServiceError(401, "INVALID_MFA_CHALLENGE", "Authentication could not be completed"); }
    if (!verified) throw new AuthServiceError(401, "INVALID_MFA_CHALLENGE", "Authentication could not be completed");
    try {
      return await sessionService.issueForUser(verified.userId, {
        expectedAuthVersion: verified.authVersion,
        mfaVerifiedAt: verified.mfaVerifiedAt,
      });
    } catch {
      throw new AuthServiceError(401, "INVALID_MFA_CHALLENGE", "Authentication could not be completed");
    }
  };

  return Object.freeze({ register, login, verifyLoginChallenge });
};
