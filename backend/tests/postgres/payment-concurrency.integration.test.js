import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDatabaseUrl } from "../../src/config/env.js";
import { createPaymentService } from "../../src/services/payment.service.js";
import { createDeterministicPaymentTestAdapter } from "../support/payment-test-adapter.js";
import { createTransactionService } from "../../src/services/transaction.service.js";

const enabled = process.env.TRUSTBRIDGE_PAYMENT_PG_TESTS === "1";
const barrier = (parties = 2) => {
  let arrivals = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => { if (++arrivals === parties) release(); await gate; };
};

test("TB-BE-038 transaction lock serializes cancellation, payment initiation, and capture", { skip: !enabled }, async (t) => {
  const baseline = new URL(getDatabaseUrl());
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(baseline.hostname));
  assert.equal(baseline.port || "5432", "5432");
  assert.equal(baseline.pathname, "/Trustbridge");
  const testUrl = new URL(baseline); testUrl.pathname = "/trustbridge_test";
  const [{ PrismaClient }, { PrismaPg }, { Client }] = await Promise.all([
    import("../../generated/prisma/client.ts"), import("@prisma/adapter-pg"), import("pg"),
  ]);
  const catalog = new Client({ connectionString: testUrl.toString() });
  await catalog.connect();
  const identity = await catalog.query("SELECT current_database() AS database, current_setting('server_version') AS version, current_setting('port') AS port, inet_server_addr()::text AS server_address, inet_client_addr()::text AS client_address");
  const migrations = await catalog.query("SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name");
  const migrationDirs = (await import("node:fs/promises")).readdir;
  const dirs = (await migrationDirs("./prisma/migrations", { withFileTypes: true })).filter((row) => row.isDirectory()).map((row) => row.name).sort();
  const row = identity.rows[0];
  const isLoopback = (value) => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128", "::ffff:127.0.0.1", "::ffff:127.0.0.1/128"].includes(value);
  const applied = migrations.rows.filter((entry) => entry.finished_at && !entry.rolled_back_at).map((entry) => entry.migration_name).sort();
  assert.equal(row.database, "trustbridge_test");
  assert.match(row.version, /^17\./);
  assert.equal(row.port, "5432");
  assert.ok(isLoopback(row.server_address));
  assert.ok(isLoopback(row.client_address));
  assert.equal(migrations.rows.filter((entry) => !entry.finished_at && !entry.rolled_back_at).length, 0);
  assert.equal(applied.length, dirs.length);
  assert.deepEqual(applied, dirs);
  const objects = await catalog.query("SELECT to_regclass('public.transactions') IS NOT NULL AS transactions, to_regclass('public.payment_attempts') IS NOT NULL AS attempts, to_regclass('public.webhook_events') IS NOT NULL AS webhooks, to_regclass('public.outbox_events') IS NOT NULL AS outbox");
  assert.ok(Object.values(objects.rows[0]).every(Boolean));
  await catalog.end();

  const makeClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
  const [a, b] = [makeClient(), makeClient()];
  const userIds = new Set(); const transactionIds = new Set(); const idemKeys = new Set();
  const adapter = createDeterministicPaymentTestAdapter();
  const payment = (client, activeAdapter = adapter) => createPaymentService({ getClient: async () => client, adapter: activeAdapter, provider: activeAdapter.providerId, enabled: true, fingerprintSecret: "isolated-payment-pg-test-fingerprint" });
  const transaction = (client) => createTransactionService({ getClient: async () => client, fingerprintSecret: "isolated-payment-pg-test-fingerprint" });
  const makeUser = async (client) => {
    const id = randomUUID(); userIds.add(id);
    await client.user.create({ data: { id, email: `${id}@tb038-pg.invalid`, passwordHash: "test-only-placeholder-hash", role: "USER", status: "ACTIVE" } });
    return id;
  };
  const makeAwaitingPayment = async (client) => {
    const buyer = await makeUser(client); const seller = await makeUser(client);
    const key = `tx-${randomUUID()}`;
    const created = await transaction(client).create({ auth: { userId: buyer, role: "USER", status: "ACTIVE", authVersion: 0 }, input: { sellerId: seller, amountMinor: "12345", currency: "USD", terms: { description: "test transaction" } }, idempotencyKey: key });
    transactionIds.add(created.id); idemKeys.add(key);
    const authBuyer = { userId: buyer, role: "USER", status: "ACTIVE", authVersion: 0 };
    const authSeller = { userId: seller, role: "USER", status: "ACTIVE", authVersion: 0 };
    await transaction(client).decideTerms({ auth: authBuyer, transactionId: created.id, version: 1, decision: "ACCEPTED" });
    await transaction(client).decideTerms({ auth: authSeller, transactionId: created.id, version: 1, decision: "ACCEPTED" });
    const invite = await transaction(client).createInvitation({ auth: authBuyer, transactionId: created.id, inviteeId: seller });
    await transaction(client).respondToInvitation({ auth: authSeller, token: invite.invitationToken, expectedVersion: 1, decision: "ACCEPTED" });
    await transaction(client).transition({ auth: authSeller, transactionId: created.id, status: "ACCEPTED", expectedVersion: 1 });
    await transaction(client).transition({ auth: authBuyer, transactionId: created.id, status: "AWAITING_PAYMENT", expectedVersion: 2 });
    return { created, buyer, seller, authBuyer, authSeller };
  };
  const cleanup = async () => {
    const txIds = [...transactionIds]; const uIds = [...userIds];
    const payments = txIds.length ? await a.paymentAttempt.findMany({ where: { transactionId: { in: txIds } }, select: { id: true } }) : [];
    const pIds = payments.map((paymentAttempt) => paymentAttempt.id);
    if (pIds.length) await a.webhookEvent.deleteMany({ where: { paymentAttemptId: { in: pIds } } });
    if (txIds.length) {
      await a.outboxEvent.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.paymentAttempt.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.transactionInvitation.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.transactionTermsDecision.deleteMany({ where: { termsVersion: { transactionId: { in: txIds } } } });
      await a.transactionTermsVersion.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: uIds } }, { entityId: { in: txIds } }] } });
      await a.transactionStatusHistory.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.transactionParticipant.deleteMany({ where: { transactionId: { in: txIds } } });
      await a.idempotencyOperation.deleteMany({ where: { OR: [{ resourceId: { in: txIds } }, { resourceId: { in: pIds } }] } });
      await a.transaction.deleteMany({ where: { id: { in: txIds } } });
    }
    if (uIds.length) await a.user.deleteMany({ where: { id: { in: uIds } } });
  };
  try {
    await t.test("concurrent initiation and buyer cancellation cannot both succeed", async () => {
      const fixture = await makeAwaitingPayment(a);
      const key = `pay-${randomUUID()}`; idemKeys.add(key);
      const start = barrier();
      const results = await Promise.allSettled([
        (async () => { await start(); return payment(a).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key }); })(),
        (async () => { await start(); return transaction(b).transition({ auth: fixture.authBuyer, transactionId: fixture.created.id, status: "CANCELLED", expectedVersion: 3 }); })(),
      ]);
      const cancelled = results[1].status === "fulfilled";
      const attempts = await a.paymentAttempt.findMany({ where: { transactionId: fixture.created.id } });
      const current = await a.transaction.findUnique({ where: { id: fixture.created.id }, select: { status: true } });
      if (cancelled) { assert.equal(current.status, "CANCELLED"); assert.equal(attempts.length, 0); assert.equal(results[0].status, "rejected"); }
      else { assert.equal(current.status, "AWAITING_PAYMENT"); assert.equal(attempts.length, 1); assert.equal(results[1].status, "rejected"); }
    });
    await t.test("duplicate concurrent initiation is idempotent and outbox dispatch is claimed once", async () => {
      const fixture = await makeAwaitingPayment(a);
      const key = `pay-${randomUUID()}`; idemKeys.add(key);
      let providerCalls = 0;
      const countedAdapter = { ...adapter, async createPaymentIntent(input) { providerCalls += 1; return adapter.createPaymentIntent(input); } };
      const start = barrier();
      const [first, second] = await Promise.all([
        (async () => { await start(); return payment(a, countedAdapter).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key }); })(),
        (async () => { await start(); return payment(b, countedAdapter).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key }); })(),
      ]);
      assert.equal(first.attempt.id, second.attempt.id);
      assert.equal([first.idempotent, second.idempotent].filter(Boolean).length, 1);
      assert.equal(providerCalls, 1);
      assert.equal(await a.paymentAttempt.count({ where: { transactionId: fixture.created.id } }), 1);
    });
    await t.test("concurrent cancellation cannot win against verified capture processing", async () => {
      const fixture = await makeAwaitingPayment(a);
      const key = `pay-${randomUUID()}`; idemKeys.add(key);
      const initiated = await payment(a).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key });
      const attempt = await a.paymentAttempt.findFirst({ where: { transactionId: fixture.created.id } });
      assert.equal(attempt.status, "PENDING");
      const rawBody = Buffer.from(JSON.stringify({ eventId: `evt-${randomUUID()}`, providerReference: attempt.providerReference, outcome: "CAPTURED", amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim() }));
      const signature = adapter.signTestEvent(rawBody);
      const start = barrier();
      const [capture, cancel] = await Promise.allSettled([
        (async () => { await start(); return payment(b).receiveWebhook({ provider: adapter.providerId, rawBody, signature }); })(),
        (async () => { await start(); return transaction(a).transition({ auth: fixture.authBuyer, transactionId: fixture.created.id, status: "CANCELLED", expectedVersion: 3 }); })(),
      ]);
      assert.equal(capture.status, "fulfilled");
      assert.equal(cancel.status, "rejected");
      const stored = await a.paymentAttempt.findUnique({ where: { id: attempt.id } });
      const current = await a.transaction.findUnique({ where: { id: fixture.created.id }, select: { status: true } });
      assert.equal(stored.status, "CAPTURED");
      assert.equal(current.status, "AWAITING_PAYMENT");
      assert.equal(initiated.attempt.amountMinor, "12345");
    });
    await t.test("verified terminal no-capture outcome permits serialized cancellation", async () => {
      const fixture = await makeAwaitingPayment(a);
      const key = `pay-${randomUUID()}`; idemKeys.add(key);
      await payment(a).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key });
      const attempt = await a.paymentAttempt.findFirst({ where: { transactionId: fixture.created.id } });
      const rawBody = Buffer.from(JSON.stringify({ eventId: `evt-${randomUUID()}`, providerReference: attempt.providerReference, outcome: "FAILED", final: true, noCapture: true, amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim() }));
      await payment(b).receiveWebhook({ provider: adapter.providerId, rawBody, signature: adapter.signTestEvent(rawBody) });
      const cancelled = await transaction(a).transition({ auth: fixture.authBuyer, transactionId: fixture.created.id, status: "CANCELLED", expectedVersion: 3 });
      assert.equal(cancelled.status, "CANCELLED");
      const stored = await a.paymentAttempt.findUnique({ where: { id: attempt.id }, include: { webhookEvents: true } });
      assert.equal(stored.status, "FAILED");
      assert.ok(stored.webhookEvents.some((event) => event.status === "PROCESSED" && event.eventData.final === true && event.eventData.noCapture === true));
    });
    await t.test("payment reservation and webhook outcome roll back atomically on audit failure", async () => {
      const fixture = await makeAwaitingPayment(a);
      const key = `pay-${randomUUID()}`; idemKeys.add(key);
      await assert.rejects(payment(a).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key, requestId: "r".repeat(129) }), { code: "PAYMENT_UNAVAILABLE" });
      assert.equal(await a.paymentAttempt.count({ where: { transactionId: fixture.created.id } }), 0);
      assert.equal(await a.outboxEvent.count({ where: { transactionId: fixture.created.id } }), 0);
      const initiated = await payment(a).initiate({ auth: fixture.authBuyer, transactionId: fixture.created.id, idempotencyKey: key });
      const attempt = await a.paymentAttempt.findFirst({ where: { transactionId: fixture.created.id } });
      const rawBody = Buffer.from(JSON.stringify({ eventId: `evt-${randomUUID()}`, providerReference: attempt.providerReference, outcome: "CAPTURED", amountMinor: attempt.amountMinor.toString(), currency: attempt.currency.trim() }));
      const signature = adapter.signTestEvent(rawBody);
      await assert.rejects(payment(b).receiveWebhook({ provider: adapter.providerId, rawBody, signature, requestId: "r".repeat(129) }), { code: "PAYMENT_UNAVAILABLE" });
      assert.equal((await a.paymentAttempt.findUnique({ where: { id: attempt.id } })).status, "PENDING");
      assert.equal(await a.webhookEvent.count({ where: { paymentAttemptId: attempt.id } }), 0);
      const outcome = await payment(b).receiveWebhook({ provider: adapter.providerId, rawBody, signature });
      assert.equal(outcome.status, "CAPTURED");
      assert.equal(initiated.attempt.status, "PENDING");
    });
  } finally {
    await cleanup();
    assert.equal(await a.user.count({ where: { email: { endsWith: "@tb038-pg.invalid" } } }), 0, "payment integration fixtures must be fully removed");
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  }
});
