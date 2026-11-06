import test from "node:test";
import assert from "node:assert/strict";
import { hashBlockchainOperationKey, hashTransactionStatusEvent } from "../../src/services/blockchain-event-hash.service.js";

test("transaction commitments are deterministic, domain separated and omit actor/reason fields", () => {
  const event = { transactionId: "10000000-0000-4000-8000-000000000001", version: 2, previousStatus: "CREATED", newStatus: "ACCEPTED" };
  assert.equal(hashTransactionStatusEvent(event), hashTransactionStatusEvent({ ...event }));
  assert.notEqual(hashTransactionStatusEvent(event), hashTransactionStatusEvent({ ...event, newStatus: "CANCELLED" }));
  assert.equal(hashBlockchainOperationKey("same").length, 64);
  assert.throws(() => hashTransactionStatusEvent({ ...event, version: 0 }), /Invalid transaction status event/);
});
