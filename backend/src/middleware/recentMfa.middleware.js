import { getPrismaClient } from "../config/db.js";
import { getEnv } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { DEFAULT_STEP_UP_PURPOSES, resolveStepUpPurpose } from "../services/step-up-purpose.registry.js";

const denied = () => new ApiError(403, "MFA_ASSURANCE_REQUIRED", "Recent MFA verification is required");
const unavailable = () => new ApiError(503, "MFA_STEP_UP_UNAVAILABLE", "Additional authentication is temporarily unavailable");

// When purpose is supplied, authorization comes only from a persisted,
// consumed challenge bound to this user, session, purpose and resource.
// The legacy no-purpose form checks recent login assurance only and must not
// be used to protect a purpose-sensitive operation.
export const createRecentMfaMiddleware = ({
  purpose,
  resourceId,
  resourceIdParam = "id",
  purposeRegistry = DEFAULT_STEP_UP_PURPOSES,
  getClient = getPrismaClient,
  maxAgeSeconds,
  now = () => new Date(),
} = {}) => async (request, _response, next) => {
  const auth = request.auth;
  if (!auth || typeof auth.userId !== "string" || !auth.userId || auth.mfaEnabled !== true || !(auth.mfaVerifiedAt instanceof Date)) return next(denied());
  const currentTime = now();
  const verifiedTime = auth.mfaVerifiedAt.getTime();
  if (!Number.isFinite(currentTime.getTime()) || !Number.isFinite(verifiedTime) || verifiedTime > currentTime.getTime()) return next(denied());

  if (purpose === undefined) {
    const maximum = maxAgeSeconds ?? getEnv().mfa.assuranceMaxAgeSeconds;
    if (!Number.isInteger(maximum) || maximum < 60 || maximum > 3600 || currentTime.getTime() - verifiedTime > maximum * 1000) return next(denied());
    return next();
  }

  if (typeof auth.sessionId !== "string" || !Number.isSafeInteger(auth.authVersion)) return next(denied());

  const definition = resolveStepUpPurpose(purposeRegistry, purpose);
  if (!definition || !definition.allowedRoles.includes(auth.role)) return next(denied());
  const requestedResourceId = typeof resourceId === "function" ? resourceId(request) : resourceId ?? request.params?.[resourceIdParam];
  if (definition.resourceRequired && (typeof requestedResourceId !== "string" || !requestedResourceId)) return next(denied());
  const boundResourceId = definition.resourceRequired ? requestedResourceId : auth.userId;
  const effectiveAge = Math.min(definition.maxAgeSeconds, maxAgeSeconds ?? definition.maxAgeSeconds);
  if (!Number.isInteger(effectiveAge) || effectiveAge < 1 || effectiveAge > 3600) return next(denied());
  const cutoff = new Date(currentTime.getTime() - effectiveAge * 1000);

  try {
    const prisma = await getClient();
    const where = {
      userId: auth.userId,
      sessionId: auth.sessionId,
      purpose: "STEP_UP",
      operationPurpose: purpose,
      resourceType: definition.resourceType,
      resourceId: boundResourceId ?? auth.userId,
      authVersion: auth.authVersion,
      consumedAt: { not: null },
      verifiedAt: { gte: cutoff, lte: currentTime },
      mfaEnabledAt: { not: null },
      user: { is: { status: "ACTIVE", authVersion: auth.authVersion, mfa: { is: { enrollmentStatus: "ENABLED", enabledAt: { not: null } } } } },
      session: { is: { userId: auth.userId, authVersion: auth.authVersion, revokedAt: null, expiresAt: { gt: currentTime }, mfaVerifiedAt: { not: null } } },
    };
    if (definition.oneTime) {
  const authorized = await prisma.$transaction(async (tx) => {
    const mfaRows = await tx.$queryRaw`
      SELECT
        "enrollment_status" AS "enrollmentStatus",
        "enabled_at" AS "enabledAt"
      FROM "user_mfa"
      WHERE "user_id" = ${auth.userId}::uuid
      FOR UPDATE
    `;

    const currentMfa = mfaRows[0];

    if (
      !currentMfa ||
      currentMfa.enrollmentStatus !== "ENABLED" ||
      !(currentMfa.enabledAt instanceof Date)
    ) {
      return false;
    }

    const challenge = await tx.mfaChallenge.findFirst({
      where: {
        ...where,
        grantConsumedAt: null,
        mfaEnabledAt: currentMfa.enabledAt,
      },
      orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
      select: { id: true },
    });

    if (!challenge) return false;

    const changed = await tx.mfaChallenge.updateMany({
      where: {
        id: challenge.id,
        ...where,
        grantConsumedAt: null,
        mfaEnabledAt: currentMfa.enabledAt,
        user: {
          is: {
            status: "ACTIVE",
            authVersion: auth.authVersion,
            mfa: {
              is: {
                enrollmentStatus: "ENABLED",
                enabledAt: currentMfa.enabledAt,
              },
            },
          },
        },
        session: {
          is: {
            userId: auth.userId,
            authVersion: auth.authVersion,
            revokedAt: null,
            expiresAt: { gt: currentTime },
            mfaVerifiedAt: { not: null },
          },
        },
      },
      data: {
        grantConsumedAt: currentTime,
      },
    });

    return changed.count === 1;
  });

  return authorized ? next() : next(denied());
}
    const grant = await prisma.mfaChallenge.findFirst({ where, select: { id: true, mfaEnabledAt: true, user: { select: { mfa: { select: { enabledAt: true } } } } } });
    const sameEnrollment = grant?.mfaEnabledAt instanceof Date && grant.user?.mfa?.enabledAt instanceof Date
      && grant.mfaEnabledAt.getTime() === grant.user.mfa.enabledAt.getTime();
    return sameEnrollment ? next() : next(denied());
  } catch { return next(unavailable()); }
};

export const createStepUpAuthorizationMiddleware = (options) => {
  if (!options || typeof options.purpose !== "string" || !resolveStepUpPurpose(options.purposeRegistry ?? DEFAULT_STEP_UP_PURPOSES, options.purpose)) throw new TypeError("A registered step-up purpose is required");
  return createRecentMfaMiddleware(options);
};

export const requireRecentMfa = createRecentMfaMiddleware();
