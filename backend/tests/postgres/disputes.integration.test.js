import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createDisputeService } from "../../src/services/dispute.service.js";
import { createEscrowService } from "../../src/services/escrow.service.js";

const enabled = process.env.TRUSTBRIDGE_DISPUTE_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_test";
assert.ok(["trustbridge_test", "trustbridge_tb050_clean"].includes(testDatabase), "only approved isolated PostgreSQL test databases are allowed");
const loopback = (value) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(value);

test("isolated PostgreSQL serializes dispute creation and partial refund then seller release workflow", { skip: !enabled }, async (t) => {
  const base = new URL(getDatabaseUrl());
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(base.hostname)); assert.equal(base.port || "5432", "5432");
  const target = new URL(base); target.pathname = `/${testDatabase}`;
  const [{ PrismaClient }, { PrismaPg }, { Client }, fs] = await Promise.all([
    import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg"), import("node:fs/promises"),
  ]);
  const inspection = new Client({ connectionString: target.toString() }); await inspection.connect();
  try {
    const identity = (await inspection.query("SELECT current_database() database,current_setting('server_version') version,current_setting('port') port,inet_server_addr()::text server,inet_client_addr()::text client")).rows[0];
    const history = (await inspection.query("SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations")).rows;
    const directories = (await fs.readdir("./prisma/migrations", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.equal(identity.database, testDatabase); assert.match(identity.version, /^17\./); assert.equal(identity.port, "5432"); assert.ok(loopback(identity.server)); assert.ok(loopback(identity.client));
    assert.equal(history.filter((row) => !row.finished_at && !row.rolled_back_at).length, 0);
    assert.deepEqual(history.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name).sort(), directories, "test DB must be fully migrated before fixture writes");
  } finally { await inspection.end(); }

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString() }) });
  const [a, b] = [makeClient(), makeClient()]; const userIds = [randomUUID(), randomUUID(), randomUUID()]; const txId = randomUUID(); const rollbackTxId = randomUUID();
  let preserve = false;
  t.after(async () => {
    try {
      if (!preserve) {
        for (const id of [txId, rollbackTxId]) {
          await a.disputeActivity.deleteMany({ where: { dispute: { transactionId: id } } });
          await a.evidence.deleteMany({ where: { dispute: { transactionId: id } } });
          await a.dispute.deleteMany({ where: { transactionId: id } });
          await a.deliveryDecision.deleteMany({ where: { delivery: { transactionId: id } } });
          await a.transactionDelivery.deleteMany({ where: { transactionId: id } });
          await a.transactionStatusHistory.deleteMany({ where: { transactionId: id } });
          await a.outboxEvent.deleteMany({ where: { transactionId: id } });
          await a.escrowOperation.deleteMany({ where: { transactionId: id } });
          await a.escrow.deleteMany({ where: { transactionId: id } });
          await a.transactionParticipant.deleteMany({ where: { transactionId: id } });
          await a.transaction.deleteMany({ where: { id } });
        }
        await a.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
        await a.userMfa.deleteMany({ where: { userId: { in: userIds } } });
        await a.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
  });

  for (let index = 0; index < userIds.length; index += 1) await a.user.create({ data: { id: userIds[index], email: `${userIds[index]}@tb040-pg.invalid`, passwordHash: "test-only-placeholder-hash", role: index === 2 ? "ADMIN" : "USER", status: "ACTIVE" } });
  const buyerId = userIds[0]; const sellerId = userIds[1]; const adminId = userIds[2];
  const createTransaction = async (id, status) => a.transaction.create({ data: { id, buyerId, sellerId, createdById: buyerId, status, amountMinor: 9000n, currency: "INR", terms: { synthetic: true }, participants: { create: [{ userId: buyerId, role: "BUYER" }, { userId: sellerId, role: "SELLER" }] } } });
  await createTransaction(txId, "DELIVERED");
  const acceptedDelivery = await a.transactionDelivery.create({ data: { transactionId: txId, sequence: 1, submittedById: sellerId, description: "synthetic completed delivery" } });
  await a.deliveryDecision.create({ data: { deliveryId: acceptedDelivery.id, actorUserId: buyerId, decision: "ACCEPTED", reason: "synthetic integration fixture" } });
  const seededEscrow = await a.escrow.create({ data: { transactionId: txId, currency: "INR", balanceMinor: 9000n, status: "FUNDED" } });
  await a.$transaction(async (tx) => {
    const clearing = await tx.ledgerAccount.create({ data: { transactionId: txId, currency: "INR", accountCode: "PROVIDER_CLEARING", accountType: "ASSET" } });
    const liability = await tx.ledgerAccount.create({ data: { transactionId: txId, escrowId: seededEscrow.id, currency: "INR", accountCode: "ESCROW_LIABILITY", accountType: "LIABILITY" } });
    const journal = await tx.ledgerJournal.create({ data: { transactionId: txId, currency: "INR", operationId: `FUNDING:pg-fixture:${txId}` } });
    await tx.ledgerEntry.createMany({ data: [
      { journalId: journal.id, transactionId: txId, currency: "INR", accountId: clearing.id, amountMinor: 9000n, direction: "DEBIT" },
      { journalId: journal.id, transactionId: txId, currency: "INR", accountId: liability.id, amountMinor: 9000n, direction: "CREDIT" },
    ] });
    await tx.escrowOperation.create({ data: {
      transactionId: txId, escrowId: seededEscrow.id, ledgerJournalId: journal.id,
      type: "FUNDING", status: "SUCCEEDED", idempotencyKey: `FUNDING:pg-fixture:${txId}`,
      operationKey: `FUNDING:pg-fixture:${txId}`, amountMinor: 9000n, currency: "INR",
      reasonCode: "TEST_FIXTURE_FUNDING", completedAt: new Date(),
    } });
  });
  await createTransaction(rollbackTxId, "DELIVERED");

  const enabledAt = new Date(Date.now() - 60_000); const sessionId = randomUUID();
  await a.userMfa.create({ data: { userId: adminId, enrollmentStatus: "ENABLED", enabledAt, secretCiphertext: Buffer.from([1]), secretNonce: Buffer.alloc(12, 1), secretAuthTag: Buffer.alloc(16, 1), secretKeyId: "pg-test", secretKeyVersion: 1 } });
  await a.refreshToken.create({ data: { id: sessionId, userId: adminId, tokenHash: randomUUID().replaceAll("-", ""), familyId: randomUUID(), authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaVerifiedAt: enabledAt, createdAt: enabledAt, expiresAt: new Date(Date.now() + 60 * 60_000) } });
  const auth = (userId, role) => ({ userId, role, status: "ACTIVE", authVersion: 0 });
  const adminAuth = { ...auth(adminId, "ADMIN"), sessionId, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: enabledAt };
  const buyerAuth = { ...auth(buyerId, "USER"), sessionId: (await a.refreshToken.create({ data: { userId: buyerId, tokenHash: randomUUID().replaceAll("-", ""), familyId: randomUUID(), authVersion: 0, assuranceLevel: "TOTP_VERIFIED", mfaVerifiedAt: enabledAt, createdAt: enabledAt, expiresAt: new Date(Date.now() + 60 * 60_000) } })).id, assuranceLevel: "TOTP_VERIFIED", mfaEnabled: true, mfaVerifiedAt: enabledAt };
  await a.userMfa.create({ data: { userId: buyerId, enrollmentStatus: "ENABLED", enabledAt, secretCiphertext: Buffer.from([2]), secretNonce: Buffer.alloc(12, 2), secretAuthTag: Buffer.alloc(16, 2), secretKeyId: "pg-test", secretKeyVersion: 1 } });
  const makeDisputeService = (client) => createDisputeService({ getClient: async () => client, fingerprintSecret: "integration-fingerprint-secret" });
  const input = { category: "QUALITY", description: "Delivered work materially differs from agreed terms." };
  const concurrent = await Promise.allSettled([a, b].map((client, index) => makeDisputeService(client).create({ auth: auth(index === 0 ? buyerId : sellerId, "USER"), transactionId: txId, input, idempotencyKey: `pg-dispute-create-${index}-001` })));
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const created = concurrent.find((result) => result.status === "fulfilled").value.dispute;
  assert.equal((await a.transaction.findUnique({ where: { id: txId } })).status, "DISPUTED");
  assert.equal(await a.dispute.count({ where: { transactionId: txId, status: { in: ["OPEN", "UNDER_REVIEW"] } } }), 1);

  const disputes = makeDisputeService(a); await disputes.startReview({ auth: adminAuth, disputeId: created.id });
  const resolutions = await Promise.allSettled([a, b].map((client) => makeDisputeService(client).resolve({ auth: adminAuth, disputeId: created.id, outcome: "PARTIAL_REFUND", amountMinor: "2500", reason: "Evidence supports a proportional refund." })));
  assert.equal(resolutions.filter((result) => result.status === "fulfilled").length, 1);
  const adjudication = resolutions.find((result) => result.status === "fulfilled").value;
  assert.equal(adjudication.resolutionAmountMinor, "2500");
  const escrowService = createEscrowService({ getClient: async () => a, refundExecutor: async ({ amountMinor }) => ({ verified: true, outcome: "SUCCEEDED", provider: "test-mock", providerReference: `refund-${amountMinor}`, amountMinor, currency: "INR" }), releaseExecutor: async ({ amountMinor }) => ({ verified: true, outcome: "SUCCEEDED", provider: "test-mock", providerReference: `transfer-${amountMinor}`, amountMinor, currency: "INR" }) });
  assert.equal((await escrowService.reconcileLedger({ transactionId: txId })).status, "CONSISTENT");
  const refundAuthorization = await escrowService.authorizeRefund({ auth: adminAuth, transactionId: txId, idempotencyKey: "partial-refund-approval-001", reasonCode: "ADMIN_RESOLVED_REFUND" });
  const refundOperation = await a.escrowOperation.findUnique({ where: { id: refundAuthorization.operationId } });
  assert.equal(refundOperation.amountMinor, 2500n); assert.equal(refundOperation.reasonCode, "ADMIN_RESOLVED_PARTIAL_REFUND");
  assert.equal((await escrowService.executeAuthorizedOperation({ operationId: refundOperation.id })).status, "SUCCEEDED");
  assert.equal((await a.escrow.findUnique({ where: { transactionId_currency: { transactionId: txId, currency: "INR" } } })).balanceMinor, 6500n);
  assert.equal((await a.transaction.findUnique({ where: { id: txId } })).status, "DELIVERED");
  assert.equal((await escrowService.reconcileLedger({ transactionId: txId })).escrowBalanceMinor, "6500");
  assert.equal((await escrowService.reconcileLedger({ transactionId: txId })).status, "CONSISTENT");

  const release = await escrowService.authorizeRelease({ auth: buyerAuth, transactionId: txId, idempotencyKey: "remaining-release-approval-001", reasonCode: "BUYER_ACCEPTED_DELIVERY" });
  assert.equal((await a.escrowOperation.findUnique({ where: { id: release.operationId } })).amountMinor, 6500n);
  assert.equal((await escrowService.executeAuthorizedOperation({ operationId: release.operationId })).status, "SUCCEEDED");
  assert.equal((await a.transaction.findUnique({ where: { id: txId } })).status, "COMPLETED");
  assert.equal((await a.escrow.findUnique({ where: { transactionId_currency: { transactionId: txId, currency: "INR" } } })).balanceMinor, 0n);
  assert.equal((await escrowService.reconcileLedger({ transactionId: txId })).status, "CONSISTENT");
  assert.equal((await a.dispute.findUnique({ where: { id: created.id } })).status, "CLOSED");
  assert.equal(await a.ledgerJournal.count({ where: { transactionId: txId } }), 3, "funding, partial refund and release each have one journal");

  const collision = await a.transactionStatusHistory.create({ data: { transactionId: rollbackTxId, version: 2, previousStatus: "DELIVERED", newStatus: "DISPUTED", actorUserId: buyerId, reason: "fixture uniqueness collision" } });
  await assert.rejects(makeDisputeService(a).create({ auth: auth(buyerId, "USER"), transactionId: rollbackTxId, input, idempotencyKey: "pg-dispute-rollback-001" }));
  assert.equal((await a.transaction.findUnique({ where: { id: rollbackTxId } })).status, "DELIVERED");
  assert.equal(await a.dispute.count({ where: { transactionId: rollbackTxId } }), 0);
  assert.equal(await a.idempotencyOperation.count({ where: { operationScope: `DISPUTE_CREATE:${rollbackTxId}:${buyerId}` } }), 0);
  assert.ok(collision.id);
  preserve = true; // immutable posted financial journals are retained in the isolated test DB.
});
