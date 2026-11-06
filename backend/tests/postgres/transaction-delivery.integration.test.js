import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createTransactionDeliveryService } from "../../src/services/transaction-delivery.service.js";

const enabled = process.env.TRUSTBRIDGE_TRANSACTION_DELIVERY_PG_TESTS === "1";
const testDatabase = process.env.TRUSTBRIDGE_PG_TEST_DATABASE ?? "trustbridge_test";
assert.ok(["trustbridge_test", "trustbridge_tb050_clean"].includes(testDatabase), "only approved isolated PostgreSQL test databases are allowed");
const auth = (userId) => ({ userId, authVersion: 0 });

test("delivery state workflow serializes submission and buyer decision in isolated PostgreSQL", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl()); assert.equal(baseline.hostname, "localhost"); assert.equal(baseline.port || "5432", "5432");
  const url = new URL(baseline); url.pathname = `/${testDatabase}`;
  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg")]);
  const make = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const [a, b] = [make(), make()]; const catalog = new Client({ connectionString: url.toString() });
  const userIds = [randomUUID(), randomUUID()]; const transactionIds = [randomUUID(), randomUUID()]; const deliveryIds = new Set();
  const service = (client) => createTransactionDeliveryService({ getClient: async () => client });
  const createFixture = async (transactionId, status = "IN_PROGRESS", evidenceRequirements = []) => {
    const [buyerId, sellerId] = userIds;
    await a.transaction.create({ data: { id: transactionId, buyerId, sellerId, createdById: buyerId, status, amountMinor: 1000n, currency: "INR", terms: { description: "test" }, version: 5 } });
    await a.transactionParticipant.createMany({ data: [{ transactionId, userId: buyerId, role: "BUYER" }, { transactionId, userId: sellerId, role: "SELLER" }] });
    await a.transactionTermsVersion.create({ data: { transactionId, version: 1, proposedById: buyerId, amountMinor: 1000n, currency: "INR", details: { description: "test", evidenceRequirements }, status: "ACCEPTED" } });
  };
  const cleanup = async () => {
    if (deliveryIds.size) { await a.deliveryDecision.deleteMany({ where: { deliveryId: { in: [...deliveryIds] } } }); await a.transactionDelivery.deleteMany({ where: { id: { in: [...deliveryIds] } } }); }
    await a.transactionStatusHistory.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await a.auditLog.deleteMany({ where: { entityType: "Transaction", entityId: { in: transactionIds } } });
    await a.transactionTermsVersion.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await a.transactionParticipant.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await a.transaction.deleteMany({ where: { id: { in: transactionIds } } });
    await a.user.deleteMany({ where: { id: { in: userIds } } });
  };
  try {
    await a.$connect(); await b.$connect(); await catalog.connect();
    const identity = (await catalog.query("SELECT current_database() db,current_setting('server_version') version,inet_server_addr()::text server,inet_client_addr()::text client,inet_server_port() port")).rows[0];
    assert.equal(identity.db, testDatabase); assert.match(identity.version, /^17\./); assert.equal(identity.port, 5432); assert.ok(["::1/128", "::1", "127.0.0.1/32", "127.0.0.1"].includes(identity.server)); assert.ok(["::1/128", "::1", "127.0.0.1/32", "127.0.0.1"].includes(identity.client));
    const applied = await a.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    assert.equal(applied.length, 15); assert.equal(applied.at(-1).migration_name, "20261107110000_transaction_delivery_workflow");
    const [pidA, pidB] = await Promise.all([a.$queryRaw`SELECT pg_backend_pid() pid`, b.$queryRaw`SELECT pg_backend_pid() pid`]); assert.notEqual(pidA[0].pid, pidB[0].pid);
    await a.user.createMany({ data: userIds.map((id) => ({ id, email: `${id}@delivery-pg.invalid`, passwordHash: "test-only", role: "USER", status: "ACTIVE" })) });

    await t.test("concurrent submissions yield one delivery and one history transition", async () => {
      await createFixture(transactionIds[0]);
      const input = { auth: auth(userIds[1]), transactionId: transactionIds[0], expectedVersion: 5, description: "completed work" };
      const results = await Promise.allSettled([service(a).submitDelivery(input), service(b).submitDelivery(input)]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      const rows = await a.transactionDelivery.findMany({ where: { transactionId: transactionIds[0] } }); assert.equal(rows.length, 1); deliveryIds.add(rows[0].id);
      const history = await a.transactionStatusHistory.findMany({ where: { transactionId: transactionIds[0], newStatus: "DELIVERED" } }); assert.equal(history.length, 1);
    });

    await t.test("buyer acceptance is atomic and missing agreed evidence fails closed", async () => {
      await createFixture(transactionIds[1], "DELIVERED", ["signed proof"]);
      const delivery = await a.transactionDelivery.create({ data: { id: randomUUID(), transactionId: transactionIds[1], sequence: 1, submittedById: userIds[1], description: "delivered" } }); deliveryIds.add(delivery.id);
      await assert.rejects(service(a).decideDelivery({ auth: auth(userIds[0]), transactionId: transactionIds[1], deliveryId: delivery.id, expectedVersion: 5, decision: "ACCEPTED" }), (error) => error.code === "DELIVERY_EVIDENCE_REQUIRED");
      assert.equal(await a.deliveryDecision.count({ where: { deliveryId: delivery.id } }), 0);
    });
  } finally { await cleanup().catch(() => {}); await Promise.all([a.$disconnect(), b.$disconnect(), catalog.end()]); }
});
