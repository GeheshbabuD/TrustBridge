import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

export const PARTICIPANT_ROLES = Object.freeze(["BUYER", "SELLER"]);
const participantRoles = new Set(PARTICIPANT_ROLES);
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
const authenticationRequired = () => new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");

const authenticatedUserId = (request) => {
  const auth = request.auth;
  return auth && typeof auth.userId === "string" && auth.userId.length ? auth.userId : null;
};

const verifyParticipant = async (prisma, transactionId, userId, roles, knownTransaction) => {
  const transaction = knownTransaction ?? await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, buyerId: true, sellerId: true },
  });
  if (!transaction) return null;

  const participant = await prisma.transactionParticipant.findUnique({
    where: { transactionId_userId: { transactionId, userId } },
    select: { role: true },
  });
  if (!participant || !participantRoles.has(participant.role)) return null;
  const expectedUserId = participant.role === "BUYER" ? transaction.buyerId : transaction.sellerId;
  if (expectedUserId !== userId || (roles && !roles.includes(participant.role))) return null;
  return { transactionId, role: participant.role };
};

export const requireTransactionParticipant = ({
  getClient = getPrismaClient,
  idParam = "transactionId",
  roles,
} = {}) => {
  if (roles && (!Array.isArray(roles) || !roles.length || roles.some((role) => !participantRoles.has(role)))) {
    throw new TypeError("Participant policy must list valid ParticipantRole values");
  }
  return async (request, _response, next) => {
    const userId = authenticatedUserId(request);
    if (!userId) return next(authenticationRequired());
    const transactionId = request.params?.[idParam];
    if (typeof transactionId !== "string" || !transactionId) return next(notFound());
    try {
      const prisma = await getClient();
      const access = await verifyParticipant(prisma, transactionId, userId, roles);
      if (!access) return next(notFound());
      request.authorization ??= {};
      request.authorization.transaction = Object.freeze(access);
      return next();
    } catch (error) { return next(error); }
  };
};

export const requireOwnUser = ({ idParam = "userId" } = {}) => (request, _response, next) => {
  const userId = authenticatedUserId(request);
  if (!userId) return next(authenticationRequired());
  if (request.params?.[idParam] !== userId) return next(notFound());
  return next();
};

export const requireOwnNotification = ({ getClient = getPrismaClient, idParam = "notificationId" } = {}) =>
  async (request, _response, next) => {
    const userId = authenticatedUserId(request);
    if (!userId) return next(authenticationRequired());
    const id = request.params?.[idParam];
    if (typeof id !== "string" || !id) return next(notFound());
    try {
      const prisma = await getClient();
      const notification = await prisma.notification.findUnique({ where: { id }, select: { id: true, recipientId: true } });
      if (!notification || notification.recipientId !== userId) return next(notFound());
      request.authorization ??= {};
      request.authorization.notificationId = notification.id;
      return next();
    } catch (error) { return next(error); }
  };

const transactionSelect = { id: true, buyerId: true, sellerId: true };
const requireTransactionRelation = ({ getClient, idParam, model, resourceParam }) =>
  async (request, _response, next) => {
    const userId = authenticatedUserId(request);
    if (!userId) return next(authenticationRequired());
    const id = request.params?.[idParam];
    if (typeof id !== "string" || !id) return next(notFound());
    try {
      const prisma = await getClient();
      const select = model === "dispute"
        ? { id: true, transaction: { select: transactionSelect } }
        : model === "evidence"
          ? { id: true, dispute: { select: { transaction: { select: transactionSelect } } } }
          : { id: true, transaction: { select: transactionSelect } };
      const resource = await prisma[model].findUnique({
        where: { id },
        select,
      });
      const transaction = model === "evidence"
        ? resource?.dispute?.transaction
        : resource?.transaction;
      if (!resource || !transaction) return next(notFound());
      const access = await verifyParticipant(prisma, transaction.id, userId, undefined, transaction);
      if (!access) return next(notFound());
      request.authorization ??= {};
      request.authorization[resourceParam] = resource.id;
      request.authorization.transaction = Object.freeze(access);
      return next();
    } catch (error) { return next(error); }
  };

export const requireDisputeParticipant = ({ getClient = getPrismaClient, idParam = "disputeId" } = {}) =>
  requireTransactionRelation({ getClient, idParam, model: "dispute", resourceParam: "disputeId" });

export const requireEvidenceParticipant = ({ getClient = getPrismaClient, idParam = "evidenceId" } = {}) =>
  requireTransactionRelation({ getClient, idParam, model: "evidence", resourceParam: "evidenceId" });

export const requirePaymentAttemptParticipant = ({ getClient = getPrismaClient, idParam = "paymentAttemptId" } = {}) =>
  requireTransactionRelation({ getClient, idParam, model: "paymentAttempt", resourceParam: "paymentAttemptId" });

export const requireEscrowParticipant = ({ getClient = getPrismaClient, idParam = "escrowId" } = {}) =>
  requireTransactionRelation({ getClient, idParam, model: "escrow", resourceParam: "escrowId" });
