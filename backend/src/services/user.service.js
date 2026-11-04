import { getPrismaClient } from "../config/db.js";
import { hashPassword, verifyPassword } from "./password.service.js";

export class UserServiceError extends Error {
  constructor(statusCode, code) { super("User operation could not be completed"); this.name = "UserServiceError"; this.statusCode = statusCode; this.code = code; }
}

const notFound = () => new UserServiceError(404, "USER_NOT_FOUND");
const forbidden = () => new UserServiceError(403, "FORBIDDEN");
const currentPasswordInvalid = () => new UserServiceError(403, "CURRENT_PASSWORD_INVALID");
const safeProfile = { displayName: true, preferences: true, notificationPreferences: true };
const safeUserSelect = { id: true, email: true, role: true, status: true, createdAt: true, profile: { select: safeProfile } };

export const createUserService = ({ getClient = getPrismaClient, verify = verifyPassword, hash = hashPassword, now = () => new Date() } = {}) => {
  const get = () => getClient();
  const lockUser = async (tx, userId) => tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  const writeAudit = (tx, actorUserId, action, entityId, requestId, metadata) => tx.auditLog.create({
    data: { actorUserId, action, entityType: "User", entityId, requestId: requestId ?? null, metadata }, select: { id: true },
  });
  const revokeSessionsAndInvalidateGrants = async (tx, userId, oldAuthVersion, at, reason) => {
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at, revocationReason: reason } });
    await tx.mfaChallenge.updateMany({ where: { userId, authVersion: oldAuthVersion, purpose: "STEP_UP", consumedAt: { not: null }, grantConsumedAt: null }, data: { grantConsumedAt: at } });
  };
  const requireActiveSelf = async (tx, auth) => {
    const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, email: true, role: true, status: true, authVersion: true, passwordHash: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } });
    if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion) throw notFound();
    return user;
  };

  const getMe = async (userId) => {
    const prisma = await get();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: safeUserSelect });
    if (!user || user.status !== "ACTIVE") throw notFound();
    return user;
  };

  const updateMe = async ({ auth, input }) => {
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUser(tx, auth.userId);
        const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, status: true, authVersion: true } });
        if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion) throw notFound();
        const { preferences, notificationPreferences, displayName } = input;
        const data = {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(preferences !== undefined ? { preferences: { ...(await tx.profile.findUnique({ where: { userId: auth.userId }, select: { preferences: true } }))?.preferences, ...preferences } } : {}),
          ...(notificationPreferences !== undefined ? { notificationPreferences: { ...(await tx.profile.findUnique({ where: { userId: auth.userId }, select: { notificationPreferences: true } }))?.notificationPreferences, ...notificationPreferences } } : {}),
        };
        await tx.profile.upsert({ where: { userId: auth.userId }, create: { userId: auth.userId, ...data }, update: data });
        const updated = await tx.user.findUnique({ where: { id: auth.userId }, select: safeUserSelect });
        return updated;
      });
    } catch (error) { if (error instanceof UserServiceError) throw error; throw new UserServiceError(503, "USER_STORAGE_UNAVAILABLE"); }
  };

  const changePassword = async ({ auth, currentPassword, newPassword, requestId }) => {
    const passwordHash = await hash(newPassword);
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUser(tx, auth.userId);
        const user = await requireActiveSelf(tx, auth);
        if (!await verify(currentPassword, user.passwordHash)) throw currentPasswordInvalid();
        const at = now();
        await tx.user.update({ where: { id: user.id }, data: { passwordHash, authVersion: { increment: 1 } }, select: { id: true } });
        await revokeSessionsAndInvalidateGrants(tx, user.id, user.authVersion, at, "password_changed");
        await writeAudit(tx, user.id, "USER_PASSWORD_CHANGED", user.id, requestId, { sessionsRevoked: true });
        return { changed: true, sessionsInvalidated: true };
      });
    } catch (error) { if (error instanceof UserServiceError) throw error; throw new UserServiceError(503, "USER_STORAGE_UNAVAILABLE"); }
  };

  const verifyCurrentPassword = async ({ auth, currentPassword, userOnly = false }) => {
    const prisma = await get();
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { passwordHash: true, status: true, authVersion: true, role: true } });
    if (!user || user.status !== "ACTIVE" || user.authVersion !== auth.authVersion || (userOnly && user.role !== "USER")) throw currentPasswordInvalid();
    if (!await verify(currentPassword, user.passwordHash)) throw currentPasswordInvalid();
    return true;
  };

  const deactivateMe = async ({ auth, requestId }) => {
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUser(tx, auth.userId);
        const user = await requireActiveSelf(tx, auth);
        if (user.role !== "USER") throw forbidden();
        const mfaEnabled = user.mfa?.enrollmentStatus === "ENABLED" && user.mfa.enabledAt instanceof Date;
        if (mfaEnabled && auth.mfaEnabled !== true) throw forbidden();
        const at = now();
        await tx.user.update({ where: { id: user.id }, data: { status: "DEACTIVATED", authVersion: { increment: 1 } }, select: { id: true } });
        await revokeSessionsAndInvalidateGrants(tx, user.id, user.authVersion, at, "account_deactivated");
        await writeAudit(tx, user.id, "USER_ACCOUNT_DEACTIVATED", user.id, requestId, { sessionsRevoked: true });
        return { deactivated: true, sessionsInvalidated: true };
      });
    } catch (error) { if (error instanceof UserServiceError) throw error; throw new UserServiceError(503, "USER_STORAGE_UNAVAILABLE"); }
  };

  const listAdminUsers = async ({ cursor, limit, status }) => {
    const prisma = await get();
    const rows = await prisma.user.findMany({ where: status ? { status } : {}, orderBy: { id: "asc" }, take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: safeUserSelect });
    const hasMore = rows.length > limit;
    const users = rows.slice(0, limit);
    return { users, nextCursor: hasMore ? users.at(-1)?.id ?? null : null };
  };

  const getAdminUser = async (userId) => {
    const prisma = await get();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: safeUserSelect });
    if (!user) throw notFound();
    return user;
  };

  const updateUserStatus = async ({ auth, targetUserId, status, reasonCode, requestId }) => {
    if (targetUserId === auth.userId) throw forbidden();
    const prisma = await get();
    try {
      return await prisma.$transaction(async (tx) => {
        for (const id of [auth.userId, targetUserId].sort()) await lockUser(tx, id);
        const [actor, target] = await Promise.all([
          tx.user.findUnique({ where: { id: auth.userId }, select: { role: true, status: true, authVersion: true, mfa: { select: { enrollmentStatus: true, enabledAt: true } } } }),
          tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, role: true, status: true, authVersion: true } }),
        ]);
        if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE" || actor.authVersion !== auth.authVersion
          || actor.mfa?.enrollmentStatus !== "ENABLED" || !(actor.mfa.enabledAt instanceof Date)) throw forbidden();
        const session = await tx.refreshToken.findUnique({ where: { id: auth.sessionId }, select: { userId: true, authVersion: true, assuranceLevel: true, mfaVerifiedAt: true, revokedAt: true, expiresAt: true } });
        const currentTime = now();
        if (!session || session.userId !== auth.userId || session.authVersion !== auth.authVersion || session.revokedAt
          || session.expiresAt <= currentTime || session.assuranceLevel !== "TOTP_VERIFIED" || !(session.mfaVerifiedAt instanceof Date)) throw forbidden();
        if (!target) throw notFound();
        if (target.status === "DEACTIVATED" && status !== "DEACTIVATED") throw forbidden();
        if (target.status === status) return { user: await tx.user.findUnique({ where: { id: target.id }, select: safeUserSelect }), changed: false };
        if (target.role === "ADMIN" && status !== "ACTIVE") {
          const otherMfaAdmins = await tx.user.count({ where: { id: { not: target.id }, role: "ADMIN", status: "ACTIVE", mfa: { is: { enrollmentStatus: "ENABLED", enabledAt: { not: null } } } } });
          if (otherMfaAdmins < 1) throw forbidden();
        }
        const at = now();
        await tx.user.update({ where: { id: target.id }, data: { status, authVersion: { increment: 1 } }, select: { id: true } });
        await revokeSessionsAndInvalidateGrants(tx, target.id, target.authVersion, at, "admin_status_changed");
        await writeAudit(tx, auth.userId, "ADMIN_USER_STATUS_CHANGED", target.id, requestId, { previousStatus: target.status, newStatus: status, reasonCode });
        return { user: await tx.user.findUnique({ where: { id: target.id }, select: safeUserSelect }), changed: true };
      }, { isolationLevel: "Serializable" });
    } catch (error) { if (error instanceof UserServiceError) throw error; if (error?.code === "P2034") throw forbidden(); throw new UserServiceError(503, "USER_STORAGE_UNAVAILABLE"); }
  };

  return Object.freeze({ getMe, updateMe, changePassword, verifyCurrentPassword, deactivateMe, listAdminUsers, getAdminUser, updateUserStatus });
};
