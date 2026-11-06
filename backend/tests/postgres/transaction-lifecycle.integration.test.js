import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createTransactionService } from "../../src/services/transaction.service.js";

const enabled = process.env.TRUSTBRIDGE_TRANSACTION_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_test";
assert.ok(["trustbridge_test", "trustbridge_tb050_clean"].includes(testDatabase), "only approved isolated PostgreSQL test databases are allowed");
const createBarrier = (parties = 2) => {
  let arrived = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => { arrived += 1; if (arrived === parties) release(); await gate; };
};

test("TB-BE-037/050/051 transaction lifecycle PostgreSQL integration", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl());
  assert.equal(baseline.hostname, "localhost");
  assert.equal(baseline.port || "5432", "5432");
  assert.equal(baseline.pathname, "/Trustbridge");
  const testUrl = new URL(baseline); testUrl.pathname = `/${testDatabase}`;
  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([
    import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg"),
  ]);
  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const [a, b] = [makeClient(), makeClient()];
  const catalog = new Client({ connectionString: testUrl.toString() });
  const userIds = new Set(); const transactionIds = new Set(); const idempotencyKeys = new Set();
  const service = (client) => createTransactionService({ getClient: async () => client, fingerprintSecret: "dedicated-pg-test-fingerprint-key" });
  const input = (sellerId) => ({ sellerId, amountMinor: "12345", currency: "INR", terms: { description: "Integration test transaction" } });
  const createUser = async () => {
    const id = randomUUID(); userIds.add(id);
    await a.user.create({ data: { id, email: `${id}@tb037-pg.invalid`, passwordHash: "test-only-placeholder-hash", role: "USER", status: "ACTIVE" } });
    return id;
  };
  const createTx = async (buyerId, sellerId, key = `create-${randomUUID()}`) => {
    idempotencyKeys.add(key);
    const result = await service(a).create({ auth: { userId: buyerId, role: "USER", status: "ACTIVE" }, input: input(sellerId), idempotencyKey: key });
    transactionIds.add(result.id); return result;
  };
  const authFor = (userId) => ({ userId, authVersion: 0, role: "USER", status: "ACTIVE" });
  const approveInitialTerms = async (tx) => {
    await service(a).decideTerms({ auth: authFor(tx.buyerId), transactionId: tx.id, version: 1, decision: "ACCEPTED" });
    const result = await service(a).decideTerms({ auth: authFor(tx.sellerId), transactionId: tx.id, version: 1, decision: "ACCEPTED" });
    assert.equal(result.status, "ACCEPTED");
  };
  const acceptInvitation = async (tx) => {
    const invitation = await service(a).createInvitation({ auth: authFor(tx.buyerId), transactionId: tx.id, inviteeId: tx.sellerId });
    await service(a).respondToInvitation({ auth: authFor(tx.sellerId), token: invitation.invitationToken, expectedVersion: 1, decision: "ACCEPTED" });
    return invitation;
  };
  const acceptTransaction = async (tx) => {
    await approveInitialTerms(tx); await acceptInvitation(tx);
    return service(a).transition({ auth: authFor(tx.sellerId), transactionId: tx.id, status: "ACCEPTED", expectedVersion: 1 });
  };
  const cleanup = async () => {
    const ids = [...transactionIds];
    if (ids.length) {
      await a.transactionInvitation.deleteMany({ where: { transactionId: { in: ids } } });
      await a.transactionTermsDecision.deleteMany({ where: { termsVersion: { transactionId: { in: ids } } } });
      await a.transactionTermsVersion.deleteMany({ where: { transactionId: { in: ids } } });
      await a.paymentAttempt.deleteMany({ where: { transactionId: { in: ids } } });
      await a.outboxEvent.deleteMany({ where: { transactionId: { in: ids } } });
      if (userIds.size) await a.notification.deleteMany({ where: { recipientId: { in: [...userIds] } } });
      await a.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: [...userIds] } }, { entityType: "Transaction", entityId: { in: ids } }] } });
      await a.transactionStatusHistory.deleteMany({ where: { transactionId: { in: ids } } });
      await a.transactionParticipant.deleteMany({ where: { transactionId: { in: ids } } });
      await a.idempotencyOperation.deleteMany({ where: { resourceType: "Transaction", resourceId: { in: ids } } });
      await a.transaction.deleteMany({ where: { id: { in: ids } } });
    }
    if (userIds.size) await a.user.deleteMany({ where: { id: { in: [...userIds] } } });
  };

  try {
    await a.$connect(); await b.$connect(); await catalog.connect();
    const identity = (await catalog.query("SELECT current_database() AS database,version() AS version,inet_server_addr()::text AS address,inet_server_port() AS port")).rows[0];
    assert.equal(identity.database, testDatabase);
    assert.match(identity.version, /PostgreSQL 17\.10\b/);
    assert.equal(identity.port, 5432);
    assert.ok(["::1/128", "::1", "127.0.0.1/32", "127.0.0.1"].includes(identity.address));
    const status = await a.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY migration_name`;
    const migrationDirectories = (await import("node:fs/promises")).readdir;
    const migrationNames = (await migrationDirectories("./prisma/migrations", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual(status.map((entry) => entry.migration_name).sort(), migrationNames, "isolated DB must have every current migration applied before writes");
    const [pidA, pidB] = await Promise.all([a.$queryRaw`SELECT pg_backend_pid() AS pid`, b.$queryRaw`SELECT pg_backend_pid() AS pid`]);
    assert.notEqual(pidA[0].pid, pidB[0].pid, "race clients use independent PostgreSQL connections");

    await t.test("creation assigns authenticated buyer and verified seller with atomic initial history", async () => {
      const buyer = await createUser(); const seller = await createUser();
      const created = await createTx(buyer, seller);
      const [transaction, participants, history, audit] = await Promise.all([
        a.transaction.findUnique({ where: { id: created.id } }),
        a.transactionParticipant.findMany({ where: { transactionId: created.id }, orderBy: { role: "asc" } }),
        a.transactionStatusHistory.findMany({ where: { transactionId: created.id } }),
        a.auditLog.findFirst({ where: { entityType: "Transaction", entityId: created.id, action: "TRANSACTION_CREATED" } }),
      ]);
      assert.equal(transaction.createdById, buyer); assert.equal(transaction.buyerId, buyer); assert.equal(transaction.sellerId, seller);
      assert.deepEqual(participants.map((row) => [row.userId, row.role]), [[buyer, "BUYER"], [seller, "SELLER"]].sort((x, y) => x[1].localeCompare(y[1])));
      assert.equal(history.length, 1); assert.equal(history[0].previousStatus, null); assert.equal(history[0].newStatus, "CREATED"); assert.ok(audit);
      const terms = await a.transactionTermsVersion.findMany({ where: { transactionId: created.id } });
      assert.equal(terms.length, 1); assert.equal(terms[0].version, 1); assert.equal(terms[0].status, "PENDING");
      assert.equal(created.amountMinor, "12345");
      await assert.rejects(service(a).create({ auth: authFor(buyer), input: input(buyer), idempotencyKey: `self-${randomUUID()}` }));
      await assert.rejects(service(a).create({ auth: authFor(buyer), input: input(randomUUID()), idempotencyKey: `missing-${randomUUID()}` }));
    });

    await t.test("idempotency replay returns one resource and key reuse with different input is rejected", async () => {
      const buyer = await createUser(); const seller = await createUser(); const key = `replay-${randomUUID()}`; idempotencyKeys.add(key);
      const first = await service(a).create({ auth: authFor(buyer), input: input(seller), idempotencyKey: key }); transactionIds.add(first.id);
      const replay = await service(a).create({ auth: authFor(buyer), input: input(seller), idempotencyKey: key });
      assert.equal(replay.id, first.id);
      await assert.rejects(service(a).create({ auth: authFor(buyer), input: { ...input(seller), amountMinor: "999" }, idempotencyKey: key }), { code: "IDEMPOTENCY_KEY_REUSED" });
      assert.equal(await a.transaction.count({ where: { buyerId: buyer } }), 1);
    });

    await t.test("creation failure rolls back transaction, participants, initial history and idempotency record", async () => {
      const buyer = await createUser(); const seller = await createUser(); const key = `rollback-create-${randomUUID()}`; idempotencyKeys.add(key);
      const trackedTermsBefore = await a.transactionTermsVersion.count({ where: { transactionId: { in: [...transactionIds] } } });
      const failingAudit = createTransactionService({
        getClient: async () => ({ $transaction: (callback) => a.$transaction((txClient) => callback(new Proxy(txClient, {
          get(target, property) {
            if (property === "auditLog") return { ...target.auditLog, create: async () => { throw new Error("injected audit failure"); } };
            return Reflect.get(target, property);
          },
        }))) }),
        fingerprintSecret: "dedicated-pg-test-fingerprint-key",
      });
      await assert.rejects(failingAudit.create({ auth: authFor(buyer), input: input(seller), idempotencyKey: key }), { code: "TRANSACTION_STORAGE_UNAVAILABLE" });
      const [transactions, idempotency] = await Promise.all([
        a.transaction.count({ where: { buyerId: buyer } }),
        a.idempotencyOperation.findFirst({ where: { operationScope: `TRANSACTION_CREATE:${buyer}`, idempotencyKey: key } }),
      ]);
      assert.equal(transactions, 0); assert.equal(idempotency, null);
      assert.equal(await a.transactionParticipant.count({ where: { userId: { in: [buyer, seller] } } }), 0);
      assert.equal(await a.transactionStatusHistory.count({ where: { actorUserId: buyer } }), 0);
      assert.equal(await a.transactionTermsVersion.count({ where: { transactionId: { in: [...transactionIds] } } }), trackedTermsBefore);
    });

    await t.test("only seller accepts or rejects; buyer cancellation and payment-pending transition follow the graph", async () => {
      const buyer = await createUser(); const seller = await createUser(); const tx = await createTx(buyer, seller);
      await assert.rejects(service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "ACCEPTED", expectedVersion: 1 }), { code: "TRANSACTION_TRANSITION_NOT_ALLOWED" });
      await assert.rejects(service(a).transition({ auth: authFor(seller), transactionId: tx.id, status: "ACCEPTED", expectedVersion: 1 }), { code: "TERMS_ACCEPTANCE_REQUIRED" });
      await approveInitialTerms(tx); await acceptInvitation(tx);
      const accepted = await service(a).transition({ auth: authFor(seller), transactionId: tx.id, status: "ACCEPTED", expectedVersion: 1 });
      assert.equal(accepted.version, 2);
      const awaiting = await service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "AWAITING_PAYMENT", expectedVersion: 2 });
      assert.equal(awaiting.status, "AWAITING_PAYMENT");
      await assert.rejects(service(a).transition({ auth: { ...authFor(seller), role: "ADMIN" }, transactionId: tx.id, status: "FUNDED", expectedVersion: 3 }), { code: "TRANSACTION_TRANSITION_NOT_ALLOWED" });
      const history = await a.transactionStatusHistory.findMany({ where: { transactionId: tx.id }, orderBy: { version: "asc" } });
      assert.deepEqual(history.map((row) => row.newStatus), ["CREATED", "ACCEPTED", "AWAITING_PAYMENT"]);
      assert.equal(await a.auditLog.count({ where: { entityType: "Transaction", entityId: tx.id, action: "TRANSACTION_STATUS_CHANGED" } }), 2);
      const rejected = await createTx(await createUser(), await createUser());
      const rejectedInvitation = await service(a).createInvitation({ auth: authFor(rejected.buyerId), transactionId: rejected.id, inviteeId: rejected.sellerId });
      const rejectedState = await service(a).respondToInvitation({ auth: authFor(rejected.sellerId), token: rejectedInvitation.invitationToken, expectedVersion: 1, decision: "REJECTED" });
      assert.equal(rejectedState.transaction.status, "REJECTED");
      const cancelled = await createTx(await createUser(), await createUser());
      assert.equal((await service(a).transition({ auth: authFor(cancelled.buyerId), transactionId: cancelled.id, status: "CANCELLED", expectedVersion: 1 })).status, "CANCELLED");
    });

    await t.test("awaiting-payment cancellation is blocked by every existing attempt until verified outcome support exists", async () => {
      for (const attemptStatus of ["CREATED", "PENDING", "CAPTURED", "FAILED", "CANCELLED"]) {
        const buyer = await createUser(); const seller = await createUser();
        const tx = await createTx(buyer, seller);
        await acceptTransaction(tx);
        await service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "AWAITING_PAYMENT", expectedVersion: 2 });
        await a.paymentAttempt.create({ data: {
          transactionId: tx.id, provider: "test-provider", idempotencyKey: `attempt-${attemptStatus}-${randomUUID()}`,
          status: attemptStatus, amountMinor: BigInt(tx.amountMinor), currency: "INR",
        } });
        await assert.rejects(service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "CANCELLED", expectedVersion: 3 }), { code: "PAYMENT_OUTCOME_UNVERIFIED" });
        const persisted = await a.transaction.findUnique({ where: { id: tx.id } });
        assert.equal(persisted.status, "AWAITING_PAYMENT");
        assert.equal(persisted.version, 3);
        assert.equal(await a.transactionStatusHistory.count({ where: { transactionId: tx.id } }), 3);
      }

      const buyer = await createUser(); const seller = await createUser();
      const tx = await createTx(buyer, seller);
      await acceptTransaction(tx);
      await service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "AWAITING_PAYMENT", expectedVersion: 2 });
      const cancelled = await service(a).transition({ auth: authFor(buyer), transactionId: tx.id, status: "CANCELLED", expectedVersion: 3 });
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(cancelled.version, 4);
    });

    await t.test("concurrent same-version transitions produce one winner and one immutable history entry", async () => {
      const buyer = await createUser(); const seller = await createUser(); const tx = await createTx(buyer, seller);
      const gate = createBarrier();
      const clientGate = (client) => ({ $transaction: async (...args) => { await gate(); return client.$transaction(...args); } });
      const outcomes = await Promise.allSettled([
        createTransactionService({ getClient: async () => clientGate(a) }).transition({ auth: authFor(buyer), transactionId: tx.id, status: "CANCELLED", expectedVersion: 1 }),
        createTransactionService({ getClient: async () => clientGate(b) }).transition({ auth: authFor(buyer), transactionId: tx.id, status: "CANCELLED", expectedVersion: 1 }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      assert.equal(await a.transactionStatusHistory.count({ where: { transactionId: tx.id } }), 2);
      assert.equal((await a.transaction.findUnique({ where: { id: tx.id } })).version, 2);
    });

    await t.test("history and transaction updates roll back together on audit failure", async () => {
      const buyer = await createUser(); const seller = await createUser(); const tx = await createTx(buyer, seller);
      await approveInitialTerms(tx); await acceptInvitation(tx);
      const failingAudit = createTransactionService({
        getClient: async () => ({ $transaction: (callback) => a.$transaction((txClient) => callback(new Proxy(txClient, {
          get(target, property) {
            if (property === "auditLog") return { ...target.auditLog, create: async () => { throw new Error("injected audit failure"); } };
            return Reflect.get(target, property);
          },
        }))) }),
      });
      await assert.rejects(failingAudit.transition({ auth: authFor(seller), transactionId: tx.id, status: "ACCEPTED", expectedVersion: 1 }), { code: "TRANSACTION_STORAGE_UNAVAILABLE" });
      const [persisted, history, audit] = await Promise.all([
        a.transaction.findUnique({ where: { id: tx.id } }),
        a.transactionStatusHistory.count({ where: { transactionId: tx.id } }),
        a.auditLog.count({ where: { entityType: "Transaction", entityId: tx.id, action: "TRANSACTION_STATUS_CHANGED" } }),
      ]);
      assert.equal(persisted.status, "CREATED"); assert.equal(persisted.version, 1); assert.equal(history, 1); assert.equal(audit, 0);
    });

    await t.test("concurrent duplicate creation with one key creates one transaction", async () => {
      const buyer = await createUser(); const seller = await createUser(); const key = `race-${randomUUID()}`; idempotencyKeys.add(key);
      const gate = createBarrier();
      const clientGate = (client) => ({
        idempotencyOperation: client.idempotencyOperation,
        transaction: client.transaction,
        $transaction: async (...args) => { await gate(); return client.$transaction(...args); },
      });
      const outcomes = await Promise.all([
        createTransactionService({ getClient: async () => clientGate(a), fingerprintSecret: "dedicated-pg-test-fingerprint-key" }).create({ auth: authFor(buyer), input: input(seller), idempotencyKey: key }),
        createTransactionService({ getClient: async () => clientGate(b), fingerprintSecret: "dedicated-pg-test-fingerprint-key" }).create({ auth: authFor(buyer), input: input(seller), idempotencyKey: key }),
      ]);
      assert.equal(outcomes[0].id, outcomes[1].id);
      transactionIds.add(outcomes[0].id);
      assert.equal(await a.transaction.count({ where: { buyerId: buyer } }), 1);
      assert.equal(await a.transactionStatusHistory.count({ where: { transactionId: outcomes[0].id } }), 1);
    });

    await t.test("concurrent terms proposals serialize into distinct auditable versions", async () => {
      const buyer = await createUser(); const seller = await createUser(); const tx = await createTx(buyer, seller);
      const gate = createBarrier();
      const serviceFor = (client) => createTransactionService({ getClient: async () => ({
        ...client,
        $transaction: async (...args) => { await gate(); return client.$transaction(...args); },
      }) });
      const proposals = await Promise.all([
        serviceFor(a).proposeTerms({ auth: authFor(buyer), transactionId: tx.id, input: { amountMinor: "15000", currency: "INR", terms: { description: "Proposal A" } } }),
        serviceFor(b).proposeTerms({ auth: authFor(seller), transactionId: tx.id, input: { amountMinor: "16000", currency: "INR", terms: { description: "Proposal B" } } }),
      ]);
      assert.deepEqual(proposals.map((row) => row.version).sort(), [2, 3]);
      const versions = await a.transactionTermsVersion.findMany({ where: { transactionId: tx.id }, orderBy: { version: "asc" } });
      assert.deepEqual(versions.map((row) => row.status), ["SUPERSEDED", "SUPERSEDED", "PENDING"]);
      assert.equal(await a.auditLog.count({ where: { entityType: "Transaction", entityId: tx.id, action: "TRANSACTION_TERMS_PROPOSED" } }), 3);
    });

    await t.test("concurrent invitation acceptance is single-use and cancellation revokes pending invitations", async () => {
      const buyer = await createUser(); const seller = await createUser(); const tx = await createTx(buyer, seller);
      const invitation = await service(a).createInvitation({ auth: authFor(buyer), transactionId: tx.id, inviteeId: seller });
      const gate = createBarrier();
      const respond = (client) => createTransactionService({ getClient: async () => ({
        ...client,
        $transaction: async (...args) => { await gate(); return client.$transaction(...args); },
      }) }).respondToInvitation({ auth: authFor(seller), token: invitation.invitationToken, expectedVersion: 1, decision: "ACCEPTED" });
      const responses = await Promise.allSettled([respond(a), respond(b)]);
      assert.equal(responses.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(responses.filter((result) => result.status === "rejected").length, 1);
      assert.equal(await a.transactionInvitation.count({ where: { transactionId: tx.id, status: "ACCEPTED" } }), 1);

      const otherBuyer = await createUser(); const otherSeller = await createUser(); const other = await createTx(otherBuyer, otherSeller);
      const cancelGate = createBarrier();
      const createInvite = createTransactionService({ getClient: async () => ({
        ...a,
        $transaction: async (...args) => { await cancelGate(); return a.$transaction(...args); },
      }) }).createInvitation({ auth: authFor(otherBuyer), transactionId: other.id, inviteeId: otherSeller });
      const cancel = createTransactionService({ getClient: async () => ({
        ...b,
        $transaction: async (...args) => { await cancelGate(); return b.$transaction(...args); },
      }) }).transition({ auth: authFor(otherBuyer), transactionId: other.id, status: "CANCELLED", expectedVersion: 1 });
      const [inviteOutcome, cancelOutcome] = await Promise.allSettled([createInvite, cancel]);
      assert.equal(cancelOutcome.status, "fulfilled");
      assert.ok(["fulfilled", "rejected"].includes(inviteOutcome.status));
      const cancelled = await a.transaction.findUnique({ where: { id: other.id } });
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(await a.transactionInvitation.count({ where: { transactionId: other.id, status: "PENDING" } }), 0);
    });
  } finally {
    await cleanup(); await catalog.end(); await b.$disconnect(); await a.$disconnect();
  }
});
