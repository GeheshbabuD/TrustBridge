import assert from "node:assert/strict";
import test from "node:test";
import { validateRequest } from "../../src/middleware/validate.middleware.js";
import { sellerLookupQuerySchema } from "../../src/validators/marketplace-query.validator.js";
import { disputeParamsSchema } from "../../src/validators/dispute.validator.js";
import { mfaEnrollmentSchema } from "../../src/validators/mfa.validator.js";

const invoke = (middleware, request) => new Promise((resolve) => middleware(request, {}, (error) => resolve(error)));

test("shared validator parses only configured sections and retains normalized values separately", async () => {
  const request = {
    body: {},
    query: { q: "  Acme  " },
    params: { disputeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  };
  const error = await invoke(validateRequest({ body: mfaEnrollmentSchema, query: sellerLookupQuerySchema, params: disputeParamsSchema }), request);

  assert.equal(error, undefined);
  assert.deepEqual({ ...request.validatedRequest.body }, {});
  assert.equal(request.validatedRequest.query.q, "Acme");
  assert.equal(request.validatedRequest.query.limit, 25);
  assert.equal(request.validatedRequest.params.disputeId, request.params.disputeId);
  assert.equal(request.query.q, "  Acme  ");
});

test("shared validator rejects malformed body, query and path with the generic validation error", async (t) => {
  const middleware = validateRequest({ body: mfaEnrollmentSchema, query: sellerLookupQuerySchema, params: disputeParamsSchema });
  const cases = [
    { name: "body", request: { body: { privileged: true }, query: { q: "valid" }, params: { disputeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } } },
    { name: "query", request: { body: {}, query: { q: "x", unexpected: "1" }, params: { disputeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } } },
    { name: "path", request: { body: {}, query: { q: "valid" }, params: { disputeId: "not-a-uuid" } } },
  ];

  for (const item of cases) await t.test(item.name, async () => {
    const error = await invoke(middleware, item.request);
    assert.equal(error?.statusCode, 400);
    assert.equal(error?.code, "VALIDATION_ERROR");
    assert.equal(error?.message, "Request validation failed");
    assert.equal(item.request.validatedRequest, undefined);
  });
});

test("shared validator rejects missing or unsupported schema configuration", () => {
  assert.throws(() => validateRequest({}), /Zod request-section schema/);
  assert.throws(() => validateRequest({ headers: mfaEnrollmentSchema }), /Zod request-section schema/);
  assert.throws(() => validateRequest({ body: {} }), /Zod request-section schema/);
});
