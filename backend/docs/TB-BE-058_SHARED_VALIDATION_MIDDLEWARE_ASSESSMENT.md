# TB-BE-058 — Shared API Validation Middleware Assessment

**Status: ASSESSMENT COMPLETE — no implementation changes.** This focused review examined the existing TB-BE-056/TB-BE-057 findings, validator/controller/route patterns, step-up middleware, error handling, and related HTTP/unit tests. No tests were run and no external systems were accessed.

## Current pattern and coverage

`src/middleware/validate.middleware.js` is empty (0 bytes) and unused. Most validation is performed with schema-specific Zod `safeParse` calls in controllers. A few route modules already perform route-level preflight validation. The same schemas can be reused; there is no need to define parallel schemas.

| API family | Existing validation | Ordering/coverage observation |
|---|---|---|
| Auth and MFA (`src/routes/auth.routes.js`, `src/controllers/auth.controller.js`) | Registration, login, challenge verification, refresh/logout, enrollment, step-up, and recovery bodies have explicit schemas; legacy recovery paths and bodies received route preflight in TB-BE-057. | `POST /mfa/recovery-codes/regenerate` and `/mfa/disable` still run one-time step-up before the controller's strict empty-body validation. Malformed bodies can burn a grant. |
| User (`user.routes.js`, `user.controller.js`) | Profile/password/deactivation/admin-status bodies, admin-user list query, and admin user ID are validated. Password/deactivation/status validation is an explicit route middleware before step-up. | Read routes validate path/query in controllers; no separate shared route contract. |
| Transactions (`transaction.routes.js`, `transaction.controller.js`) | Create, list/history queries, terms, invitations, transitions, delivery bodies, and IDs are schema-checked in controllers. | Participant middleware performs resource lookup before controller path parsing on many routes. Add cheap path validation before ownership lookups when adopting shared validation; retain ownership checks. |
| Payments (`payment.routes.js`, `payment.controller.js`, `payment.service.js`) | Initiation/callback bodies, idempotency header, path IDs, and webhook provider/raw body are checked; normalized webhook identifiers are bounded in the service after signature verification. | Participant middleware can query by raw path ID before controller validation. Webhook trust must remain behind raw-body signature verification; generic schema middleware must not parse or replace `rawBody`. |
| Escrow (`escrow.routes.js`, `escrow.controller.js`) | Release/refund route middleware validates reason/body, idempotency header, and transaction UUID before participant/role and one-time step-up checks. | This is the clearest existing route-level example. Escrow status path validation currently follows participant middleware/controller. |
| Disputes/evidence (`dispute.routes.js`, `dispute.controller.js`) | Bodies, IDs, categories, and resolution fields use strict schemas; uploads have MIME allowlists, raw-byte size limits, and service-level signature/metadata checks. TB-BE-057 added preflight for admin review and resolution. | Participant middleware precedes controller validation on participant routes. Admin dispute detail (`GET .../:disputeId`) consumes `DISPUTE_REVIEW` step-up before its controller validates the ID. Admin evidence binding queries before controller ID parsing. |
| AI (`ai.routes.js`, `ai.controller.js`) | Assessment/assistance controllers validate UUID path params and strict empty bodies. | `POST /admin/disputes/:disputeId/assistance` consumes the one-time `DISPUTE_REVIEW` grant before controller validation. Risk/baseline routes use reusable recent-TOTP checks, so malformed input does not consume a grant, though it reaches middleware before schema rejection. |
| Seller/admin listings (`marketplace.routes.js`, `admin.routes.js`, `marketplace-query.controller.js`) | Seller/admin query schemas cover filters, cursors, and limits. | Admin recent-TOTP middleware is reusable and precedes query parsing; malformed query does not consume one-time authorization. |
| Notifications (`notification.routes.js`, `notification.controller.js`) | List query and notification ID have schemas. | Ownership lookup runs before controller ID validation on mark-read. Preserve ownership enforcement; preflight syntax can avoid malformed database lookups. |

## Confirmed consistency and ordering gaps

### MEDIUM — one-time grant routes still validate after consumption

The TB-BE-057 fix corrected the listed dispute review/resolution and legacy ADMIN recovery mutation routes, but the same ordering pattern remains on:

- `POST /api/v1/auth/mfa/recovery-codes/regenerate`
- `POST /api/v1/auth/mfa/disable`
- `GET /api/v1/admin/disputes/:disputeId`
- `POST /api/v1/admin/disputes/:disputeId/assistance`

The first two validate the strict empty-body contract in the controller after one-time step-up. The latter two validate path/body in the controller after the one-time `DISPUTE_REVIEW` grant. Invalid input can consume a grant without running the requested operation. This is a grant-burn/availability and retry-consistency issue, not an authorization bypass. Add route preflight before step-up and tests asserting malformed input does not consume the grant; retain controller validation and service authorization.

### LOW — parsing is distributed and some resource lookup precedes syntax validation

Controller-local parsing is generally present, but participant/ownership middleware sometimes queries with raw route parameters before controllers validate UUID syntax. This can cause avoidable lookups or database errors for malformed IDs. No evidence in the reviewed paths indicates it grants access; ownership remains enforced separately. Add only the required route schema before lookup, not a substitute for ownership checks.

### No new mass-assignment or validation-bypass finding

The inspected write schemas are strict, and controllers generally pass parsed schema data to services rather than raw bodies. Existing transaction terms include bounded arrays, strings, depth/node count, and serialized size. Monetary inputs use integer strings and bounded BigInt ranges. Existing evidence services validate file bytes/signatures and sanitize names. Error handling maps invalid input to a generic `400 VALIDATION_ERROR`. This is focused coverage, not a repository-wide proof for every request field.

## Can shared middleware reuse schemas?

Yes. A generic middleware can accept existing per-request-part schemas (`params`, `query`, `headers`, and `body`) and call `safeParse`; it should not create duplicate domain schemas. For compatibility it should:

1. Emit the same generic `ApiError(400, "VALIDATION_ERROR", "Request validation failed")` used by current controllers, without returning Zod issue details.
2. Preserve parsed values (including defaults/transforms) in a dedicated validated-request property. Do not merge client objects into `request.auth`, persistence models, or arbitrary request properties.
3. Keep raw webhook bytes untouched and avoid applying JSON-body validation to raw evidence streams.
4. Be adopted incrementally. Once route middleware owns a schema, have the controller use that parsed result (or retain a safe direct-call fallback) rather than permanently parsing the same schema twice. Preserve existing service validation at business/security trust boundaries.
5. Keep strict schemas and explicit empty-body schemas where the API contract requires an empty object. Do not silently strip unknown fields or change query defaults/coercions.

## Recommended ordering and rollout

For ordinary protected routes: **authentication → role check → rate limit (retain current policy) → request-shape validation → ownership/resource lookup → recent or purpose-bound step-up → controller/service**. Where an existing approved route requires a different rate-limit order, keep that policy. For one-time grants, all fields that can produce a validation rejection must be checked before the step-up middleware. Step-up still validates the persisted grant and does not establish resource ownership or operation authorization.

Adopt in two small steps:

1. Implement and unit-test the generic schema adapter with contract tests for missing fields, strict unknown fields, transformed/defaulted query values, sanitized errors, and raw-body preservation.
2. Pilot only on identified one-time-step-up and raw-path-before-ownership routes. Migrate controller consumption to the middleware's parsed result without changing service inputs. Expand only after HTTP regression tests confirm identical status/error contracts.

## Risks and blockers

- **Double validation risk:** middleware plus controller can drift or duplicate work; establish one HTTP parsing contract while retaining service-level checks.
- **Order risk:** placing validation after step-up repeats grant burn; placing ownership before path parsing retains unnecessary lookups.
- **Behavior drift:** parsed defaults/coercions and strict unknown-field rejection must match the existing schema behavior exactly.
- **Body-type risk:** raw webhook/evidence routes require their current parsers and byte-preserving path; do not route them through ordinary JSON-body handling.
- **Authorization boundary:** validation must never replace authentication, RBAC, TOTP/step-up, participant ownership, or service-side state/permission checks.
- No external provider, database, or policy decision blocks implementation. PostgreSQL/provider tests are not needed for a schema-middleware unit/HTTP pilot; existing one-time grant tests should remain in the regression set.

## Progress documentation

No tracker/log change was necessary for this assessment: it creates a design artifact and does not change implementation status. TB-BE-056's empty-middleware LOW consistency gap remains open; TB-BE-057's covered routes remain corrected, with the additional affected routes above identified for follow-up.
