import { getPrismaClient } from "../config/db.js";
import { ApiError } from "../utils/ApiError.js";

const unavailable = () => new ApiError(503, "QUERY_SERVICE_UNAVAILABLE", "The requested information is temporarily unavailable");
const forbidden = () => new ApiError(403, "FORBIDDEN", "Access is not permitted");
const requireAdmin = (auth) => { if (!auth || auth.role !== "ADMIN" || auth.status !== "ACTIVE") throw forbidden(); };

const safeTransaction = ({ id, buyerId, sellerId, status, amountMinor, currency, version, createdAt, updatedAt }) => ({
  id, buyerId, sellerId, status, amountMinor: amountMinor.toString(), currency: currency.trim(), version, createdAt, updatedAt,
});
const safeDispute = ({ id, transactionId, openedById, status, category, createdAt, updatedAt, resolvedAt, closedAt, evidenceDeadlineAt, responseDeadlineAt, version }) => ({
  id, transactionId, openedById, status, category, createdAt, updatedAt, resolvedAt, closedAt, evidenceDeadlineAt, responseDeadlineAt, version,
});

export const createMarketplaceQueryService = ({ getClient = getPrismaClient } = {}) => {
  const searchSellers = async ({ q, cursor, limit }) => {
    try {
      const prisma = await getClient();
      const rows = await prisma.user.findMany({
        where: { role: "USER", status: "ACTIVE", profile: { is: { displayName: { contains: q, mode: "insensitive" } } } },
        orderBy: [{ profile: { displayName: "asc" } }, { id: "asc" }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, profile: { select: { displayName: true } } },
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map((row) => ({ id: row.id, displayName: row.profile.displayName }));
      return { sellers: page, nextCursor: hasMore ? rows[limit - 1]?.id ?? null : null };
    } catch { throw unavailable(); }
  };

  const listAdminTransactions = async ({ auth, cursor, limit, status, buyerId, sellerId, createdFrom, createdTo }) => {
    requireAdmin(auth);
    try {
      const prisma = await getClient();
      const rows = await prisma.transaction.findMany({
        where: {
          ...(status ? { status } : {}), ...(buyerId ? { buyerId } : {}), ...(sellerId ? { sellerId } : {}),
          ...(createdFrom || createdTo ? { createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, buyerId: true, sellerId: true, status: true, amountMinor: true, currency: true, version: true, createdAt: true, updatedAt: true },
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return { transactions: page.map(safeTransaction), nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  const listAdminDisputes = async ({ auth, cursor, limit, status }) => {
    requireAdmin(auth);
    try {
      const prisma = await getClient();
      const rows = await prisma.dispute.findMany({
        where: status ? { status } : {}, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, transactionId: true, openedById: true, status: true, category: true, createdAt: true, updatedAt: true, resolvedAt: true, closedAt: true, evidenceDeadlineAt: true, responseDeadlineAt: true, version: true },
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return { disputes: page.map(safeDispute), nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  };

  return Object.freeze({ searchSellers, listAdminTransactions, listAdminDisputes });
};
