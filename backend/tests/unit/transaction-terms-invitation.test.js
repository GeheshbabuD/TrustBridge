import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTransactionService } from "../../src/services/transaction.service.js";

const buyerId = "11111111-1111-4111-8111-111111111111";
const sellerId = "22222222-2222-4222-8222-222222222222";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const transactionId = "33333333-3333-4333-8333-333333333333";
const nowDate = new Date("2026-11-04T10:00:00.000Z");
const participants = [{ userId: buyerId, role: "BUYER" }, { userId: sellerId, role: "SELLER" }];

const makeFixture = ({ status = "ACCEPTED", versionStatus = "LEGACY_ACCEPTED", decisions = [] } = {}) => {
  const db = {
    transaction: { id: transactionId, buyerId, sellerId, status, amountMinor: 1000n, currency: "INR", terms: { description: "Initial" }, version: status === "CREATED" ? 1 : 2, createdAt: nowDate, updatedAt: nowDate },
    termsVersions: [{ id: "terms-v1", transactionId, version: 1, proposedById: buyerId, amountMinor: 1000n, currency: "INR", details: { description: "Initial" }, status: versionStatus, createdAt: nowDate, updatedAt: nowDate }],
    termsDecisions: decisions.map((actorUserId) => ({ id: `decision-${actorUserId}`, termsVersionId: "terms-v1", actorUserId, decision: "ACCEPTED", createdAt: nowDate })),
    invitations: [], history: [], audits: [], users: new Map([[buyerId, { status: "ACTIVE", role: "USER", authVersion: 0 }], [sellerId, { status: "ACTIVE", role: "USER", authVersion: 0 }], [outsiderId, { status: "ACTIVE", role: "USER", authVersion: 0 }]]),
  };
  const enrichVersion = (row) => row && ({ ...row, decisions: db.termsDecisions.filter((item) => item.termsVersionId === row.id) });
  const tx = {
    $queryRaw: async () => [],
    transaction: {
      findUnique: async () => ({ ...db.transaction, participants }),
      update: async ({ data }) => Object.assign(db.transaction, data),
      updateMany: async ({ where, data }) => {
        if (db.transaction.id !== where.id || db.transaction.status !== where.status || db.transaction.version !== where.version) return { count: 0 };
        Object.assign(db.transaction, { status: data.status, version: db.transaction.version + data.version.increment }); return { count: 1 };
      },
    },
    user: { findUnique: async ({ where }) => db.users.get(where.id) ?? null },
    transactionParticipant: { findUnique: async ({ where }) => {
      const userId = where.transactionId_userId.userId;
      return participants.find((row) => row.userId === userId) ?? null;
    } },
    transactionTermsVersion: {
      findFirst: async ({ where, orderBy }) => enrichVersion(db.termsVersions.filter((row) => row.transactionId === where.transactionId).sort((a, b) => b.version - a.version)[0]),
      findMany: async ({ where }) => db.termsVersions.filter((row) => row.transactionId === where.transactionId).sort((a, b) => b.version - a.version).map(enrichVersion),
      create: async ({ data }) => { const row = { id: `terms-v${data.version}`, ...data, createdAt: nowDate, updatedAt: nowDate }; db.termsVersions.push(row); return enrichVersion(row); },
      updateMany: async ({ where, data }) => { let count = 0; for (const row of db.termsVersions) if (row.transactionId === where.transactionId && row.status === where.status) { Object.assign(row, data); count += 1; } return { count }; },
      update: async ({ where, data }) => { const row = db.termsVersions.find((item) => item.id === where.id); Object.assign(row, data); return enrichVersion(row); },
      findUnique: async ({ where }) => enrichVersion(db.termsVersions.find((row) => row.id === where.id)),
    },
    transactionTermsDecision: {
      create: async ({ data }) => {
        if (db.termsDecisions.some((row) => row.termsVersionId === data.termsVersionId && row.actorUserId === data.actorUserId)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: `decision-${data.actorUserId}-${data.termsVersionId}`, ...data, createdAt: nowDate }; db.termsDecisions.push(row); return row;
      },
      findMany: async ({ where }) => db.termsDecisions.filter((row) => row.termsVersionId === where.termsVersionId && (!where.decision || row.decision === where.decision)),
    },
    transactionInvitation: {
      findUnique: async ({ where }) => db.invitations.find((row) => where.tokenHash ? row.tokenHash === where.tokenHash : row.id === where.id) ?? null,
      findFirst: async ({ where }) => db.invitations.find((row) => Object.entries(where).every(([key, value]) => key === "acceptedAt" ? (value.not === null ? row[key] !== null : row[key] === value) : row[key] === value)) ?? null,
      create: async ({ data }) => { const row = { id: `inv-${db.invitations.length + 1}`, status: "PENDING", ...data }; db.invitations.push(row); return row; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of db.invitations) {
          const matches = Object.entries(where).every(([key, value]) => key === "expiresAt" ? row.expiresAt > value.gt : row[key] === value);
          if (matches) { Object.assign(row, data); count += 1; }
        }
        return { count };
      },
    },
    paymentAttempt: { findFirst: async () => null }, escrow: { findFirst: async () => null }, dispute: { findFirst: async () => null },
    transactionStatusHistory: { create: async ({ data }) => { db.history.push(data); return data; } },
    outboxEvent: { create: async () => ({ id: "outbox-test" }) },
    auditLog: { create: async ({ data }) => { db.audits.push(data); return data; } },
  };
  const root = { ...tx, $transaction: async (callback) => callback(tx) };
  let time = nowDate;
  const service = createTransactionService({ getClient: async () => root, now: () => time, fingerprintSecret: "test-fingerprint-secret" });
  return { db, service, setNow: (value) => { time = value; } };
};
const auth = (userId) => ({ userId, role: "USER", status: "ACTIVE", authVersion: 0 });

const newTerms = { amountMinor: "2500", currency: "USD", terms: { description: "Updated work", scope: "Specified repair", delivery: { days: 3 }, evidenceRequirements: ["completion photo"], acceptanceCriteria: ["buyer confirms result"], cancellationPolicyRef: "policy.cancel.v1", disputePolicyRef: "policy.dispute.v1" } };

test("terms are versioned, decisions are immutable per participant, and the transaction snapshot changes only after both accept", async () => {
  const { db, service } = makeFixture();
  const proposal = await service.proposeTerms({ auth: auth(sellerId), transactionId, input: newTerms, requestId: "req-1" });
  assert.equal(proposal.version, 2); assert.equal(proposal.status, "PENDING"); assert.equal(proposal.amountMinor, "2500");
  assert.equal(db.transaction.amountMinor, 1000n, "pending terms do not change the agreed transaction snapshot");
  await service.decideTerms({ auth: auth(buyerId), transactionId, version: 2, decision: "ACCEPTED" });
  assert.equal(db.transaction.amountMinor, 1000n, "one approval is insufficient");
  const accepted = await service.decideTerms({ auth: auth(sellerId), transactionId, version: 2, decision: "ACCEPTED" });
  assert.equal(accepted.status, "ACCEPTED"); assert.equal(db.transaction.amountMinor, 2500n); assert.equal(db.transaction.currency, "USD");
  assert.equal(db.termsDecisions.length, 2);
  assert.deepEqual(db.audits.map((row) => row.action), ["TRANSACTION_TERMS_PROPOSED", "TRANSACTION_TERMS_ACCEPTED", "TRANSACTION_TERMS_ACCEPTED"]);
  await assert.rejects(service.decideTerms({ auth: auth(buyerId), transactionId, version: 2, decision: "ACCEPTED" }), { code: "TERMS_VERSION_CONFLICT" });
});

test("unauthorized terms edits and conflicting or rejected versions fail safely", async () => {
  const { db, service } = makeFixture({ status: "CREATED", versionStatus: "PENDING" });
  await assert.rejects(service.proposeTerms({ auth: auth(outsiderId), transactionId, input: newTerms }), { code: "RESOURCE_NOT_FOUND" });
  await assert.rejects(service.decideTerms({ auth: auth(outsiderId), transactionId, version: 1, decision: "ACCEPTED" }), { code: "RESOURCE_NOT_FOUND" });
  const rejected = await service.decideTerms({ auth: auth(sellerId), transactionId, version: 1, decision: "REJECTED" });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(db.termsVersions[0].status, "REJECTED");
  await assert.rejects(service.decideTerms({ auth: auth(buyerId), transactionId, version: 1, decision: "ACCEPTED" }), { code: "TERMS_VERSION_CONFLICT" });
});

test("invitation stores only token hash, binds invitee, and consumes once after seller accepts", async () => {
  const { db, service } = makeFixture({ status: "CREATED", versionStatus: "ACCEPTED", decisions: [buyerId, sellerId] });
  const issued = await service.createInvitation({ auth: auth(buyerId), transactionId, inviteeId: sellerId, requestId: "req-invite" });
  assert.equal(issued.invitation.status, "PENDING");
  assert.equal(issued.invitationToken.length, 43);
  const stored = db.invitations[0];
  assert.equal(stored.tokenHash, createHash("sha256").update(issued.invitationToken).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(issued.invitationToken), false);
  await assert.rejects(service.respondToInvitation({ auth: auth(outsiderId), token: issued.invitationToken, expectedVersion: 1, decision: "ACCEPTED" }), { code: "INVITATION_INVALID" });
  const response = await service.respondToInvitation({ auth: auth(sellerId), token: issued.invitationToken, expectedVersion: 1, decision: "ACCEPTED" });
  assert.equal(response.invitation.status, "ACCEPTED");
  assert.equal(db.transaction.status, "CREATED", "invitation acceptance is separate from transaction terms acceptance");
  const accepted = await service.transition({ auth: auth(sellerId), transactionId, status: "ACCEPTED", expectedVersion: 1 });
  assert.equal(accepted.status, "ACCEPTED");
  await assert.rejects(service.respondToInvitation({ auth: auth(sellerId), token: issued.invitationToken, expectedVersion: 1, decision: "ACCEPTED" }), { code: "INVITATION_INVALID" });
  assert.equal(db.history.length, 1);
  assert.ok(db.audits.some((row) => row.action === "TRANSACTION_INVITATION_ACCEPTED"));
});

test("invitation expiry and reissue revoke old tokens; rejection records terminal transaction history", async () => {
  const fixture = makeFixture({ status: "CREATED", versionStatus: "PENDING" });
  const first = await fixture.service.createInvitation({ auth: auth(buyerId), transactionId, inviteeId: sellerId });
  const second = await fixture.service.createInvitation({ auth: auth(buyerId), transactionId, inviteeId: sellerId });
  assert.equal(fixture.db.invitations[0].status, "REVOKED");
  await assert.rejects(fixture.service.respondToInvitation({ auth: auth(sellerId), token: first.invitationToken, expectedVersion: 1, decision: "ACCEPTED" }), { code: "INVITATION_INVALID" });
  fixture.setNow(new Date(nowDate.getTime() + 8 * 24 * 60 * 60 * 1000));
  await assert.rejects(fixture.service.respondToInvitation({ auth: auth(sellerId), token: second.invitationToken, expectedVersion: 1, decision: "ACCEPTED" }), { code: "INVITATION_INVALID" });

  const rejectedFixture = makeFixture({ status: "CREATED", versionStatus: "PENDING" });
  const invitation = await rejectedFixture.service.createInvitation({ auth: auth(buyerId), transactionId, inviteeId: sellerId });
  const rejected = await rejectedFixture.service.respondToInvitation({ auth: auth(sellerId), token: invitation.invitationToken, expectedVersion: 1, decision: "REJECTED" });
  assert.equal(rejected.transaction.status, "REJECTED");
  assert.equal(rejectedFixture.db.history[0].reason, "SELLER_DECLINED");
});

test("invitation acceptance rechecks invitee eligibility and does not grant ADMIN a participant bypass", async () => {
  const fixture = makeFixture({ status: "CREATED", versionStatus: "PENDING" });
  const invitation = await fixture.service.createInvitation({ auth: auth(buyerId), transactionId, inviteeId: sellerId });
  fixture.db.users.get(sellerId).role = "ADMIN";
  await assert.rejects(fixture.service.respondToInvitation({ auth: auth(sellerId), token: invitation.invitationToken, expectedVersion: 1, decision: "ACCEPTED" }), { code: "INVITATION_INVALID" });
  assert.equal(fixture.db.invitations[0].status, "PENDING");
  assert.equal(fixture.db.transaction.status, "CREATED");
});
