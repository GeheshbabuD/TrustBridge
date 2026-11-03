import assert from "node:assert/strict";
import test from "node:test";
import { requireRole, requireRoles } from "../../src/middleware/role.middleware.js";
import {
  requireDisputeParticipant,
  requireEvidenceParticipant,
  requireOwnNotification,
  requireOwnUser,
  requirePaymentAttemptParticipant,
  requireEscrowParticipant,
  requireTransactionParticipant,
} from "../../src/middleware/ownership.middleware.js";

const run = async (middleware, { auth, params = {}, query = {}, body = {} } = {}) => {
  const request = { auth, params, query, body, authorization: undefined };
  let error;
  let calls = 0;
  await middleware(request, {}, (nextError) => { calls += 1; error = nextError; });
  return { request, error, calls };
};

const participantDb = ({ transaction = { id: "tx-1", buyerId: "buyer-1", sellerId: "seller-1" }, participant = { role: "BUYER" } } = {}) => {
  const queries = [];
  return {
    queries,
    client: {
      transaction: { findUnique: async (args) => { queries.push(["transaction", args]); return transaction; } },
      transactionParticipant: { findUnique: async (args) => { queries.push(["participant", args]); return participant; } },
    },
  };
};

test("role authorization allows explicit roles and supports multiple allowed roles", async () => {
  for (const [middleware, role] of [[requireRole("ADMIN"), "ADMIN"], [requireRoles("USER", "ADMIN"), "USER"]]) {
    const { error, calls } = await run(middleware, { auth: { userId: "u1", role } });
    assert.equal(error, undefined);
    assert.equal(calls, 1);
  }
  assert.throws(() => requireRole("SUPERADMIN"), /valid UserRole/);
  assert.throws(() => requireRoles(), /valid UserRole/);
});

test("role authorization denies missing/invalid contexts and forbidden valid roles", async () => {
  for (const auth of [undefined, {}, { userId: "u1" }, { userId: "u1", role: "ROOT" }]) {
    const result = await run(requireRole("ADMIN"), { auth });
    assert.equal(result.error.statusCode, 401);
    assert.equal(result.error.code, "AUTHENTICATION_REQUIRED");
  }
  const result = await run(requireRole("ADMIN"), { auth: { userId: "u1", role: "USER" } });
  assert.equal(result.error.statusCode, 403);
  assert.equal(result.error.code, "FORBIDDEN");
});

test("buyer and seller access requires matching persisted participant role and transaction identity", async () => {
  for (const [userId, role] of [["buyer-1", "BUYER"], ["seller-1", "SELLER"]]) {
    const db = participantDb({ participant: { role } });
    const { request, error } = await run(requireTransactionParticipant({ getClient: async () => db.client }), {
      auth: { userId, role: "USER" }, params: { transactionId: "tx-1" },
    });
    assert.equal(error, undefined);
    assert.deepEqual(request.authorization.transaction, { transactionId: "tx-1", role });
  }
});

test("participant lookup ignores forged body/query IDs and rejects nonparticipants, missing transactions and role mismatch", async () => {
  const db = participantDb();
  const result = await run(requireTransactionParticipant({ getClient: async () => db.client }), {
    auth: { userId: "buyer-1", role: "USER" },
    params: { transactionId: "tx-1" }, query: { userId: "seller-1", role: "SELLER" }, body: { userId: "seller-1", role: "SELLER" },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(db.queries[1][1].where, { transactionId_userId: { transactionId: "tx-1", userId: "buyer-1" } });

  const scenarios = [
    participantDb({ participant: null }),
    participantDb({ transaction: null }),
    participantDb({ participant: { role: "SELLER" } }),
  ];
  for (const scenario of scenarios) {
    const denied = await run(requireTransactionParticipant({ getClient: async () => scenario.client }), {
      auth: { userId: "buyer-1", role: "USER" }, params: { transactionId: "tx-1" },
    });
    assert.equal(denied.error.statusCode, 404);
    assert.equal(denied.error.code, "RESOURCE_NOT_FOUND");
  }
});

test("participant role policy can require buyer and safely hides absent transactions", async () => {
  const db = participantDb({ participant: { role: "SELLER" } });
  const denied = await run(requireTransactionParticipant({ getClient: async () => db.client, roles: ["BUYER"] }), {
    auth: { userId: "buyer-1" }, params: { transactionId: "tx-1" },
  });
  assert.equal(denied.error.statusCode, 404);
  assert.throws(() => requireTransactionParticipant({ roles: ["ADMIN"] }), /valid ParticipantRole/);
});

test("own-user and notification ownership checks are server-derived", async () => {
  const self = await run(requireOwnUser(), { auth: { userId: "u1", role: "USER" }, params: { userId: "u1" } });
  assert.equal(self.error, undefined);
  const forged = await run(requireOwnUser(), { auth: { userId: "u1", role: "USER" }, params: { userId: "u2" }, body: { userId: "u1" } });
  assert.equal(forged.error.statusCode, 404);

  const own = await run(requireOwnNotification({ getClient: async () => ({ notification: { findUnique: async () => ({ id: "n1", recipientId: "u1" }) } }) }), {
    auth: { userId: "u1" }, params: { notificationId: "n1" },
  });
  assert.equal(own.error, undefined);
  const other = await run(requireOwnNotification({ getClient: async () => ({ notification: { findUnique: async () => ({ id: "n1", recipientId: "u2" }) } }) }), {
    auth: { userId: "u1" }, params: { notificationId: "n1" },
  });
  assert.equal(other.error.statusCode, 404);
});

test("dispute and evidence authorization follows their actual transaction relations", async () => {
  const transaction = { id: "tx-1", buyerId: "buyer-1", sellerId: "seller-1" };
  const membership = { findUnique: async () => ({ role: "BUYER" }) };
  const auth = { userId: "buyer-1", role: "USER" };
  const disputeClient = {
    dispute: { findUnique: async ({ select }) => {
      assert.ok(select.transaction.select.buyerId);
      return { id: "d1", transaction };
    } },
    transaction: { findUnique: async () => transaction },
    transactionParticipant: membership,
  };
  const dispute = await run(requireDisputeParticipant({ getClient: async () => disputeClient }), { auth, params: { disputeId: "d1" } });
  assert.equal(dispute.error, undefined);
  assert.equal(dispute.request.authorization.disputeId, "d1");

  const evidenceClient = {
    evidence: { findUnique: async ({ select }) => {
      assert.ok(select.dispute.select.transaction);
      return { id: "e1", dispute: { transaction } };
    } },
    transaction: { findUnique: async () => transaction },
    transactionParticipant: membership,
  };
  const evidence = await run(requireEvidenceParticipant({ getClient: async () => evidenceClient }), { auth, params: { evidenceId: "e1" } });
  assert.equal(evidence.error, undefined);
  assert.equal(evidence.request.authorization.evidenceId, "e1");

  const deniedClient = { ...evidenceClient, transactionParticipant: { findUnique: async () => null } };
  const denied = await run(requireEvidenceParticipant({ getClient: async () => deniedClient }), { auth: { userId: "intruder", role: "USER" }, params: { evidenceId: "e1" } });
  assert.equal(denied.error.statusCode, 404);
});

test("payment attempts and escrows authorize through their transaction relationship", async () => {
  const transaction = { id: "tx-1", buyerId: "buyer-1", sellerId: "seller-1" };
  for (const [model, middleware, param] of [
    ["paymentAttempt", requirePaymentAttemptParticipant, "paymentAttemptId"],
    ["escrow", requireEscrowParticipant, "escrowId"],
  ]) {
    const client = {
      [model]: { findUnique: async ({ select }) => {
        assert.ok(select.transaction.select.sellerId);
        return { id: "resource-1", transaction };
      } },
      transactionParticipant: { findUnique: async () => ({ role: "BUYER" }) },
    };
    const result = await run(middleware({ getClient: async () => client }), {
      auth: { userId: "buyer-1", role: "USER" }, params: { [param]: "resource-1" },
    });
    assert.equal(result.error, undefined, model);
    assert.equal(result.request.authorization.transaction.transactionId, "tx-1");
  }
});

test("missing authenticated context is rejected before ownership database access", async () => {
  let queries = 0;
  const result = await run(requireOwnNotification({ getClient: async () => { queries += 1; return {}; } }), {
    params: { notificationId: "n1" },
  });
  assert.equal(result.error.statusCode, 401);
  assert.equal(queries, 0);
});
