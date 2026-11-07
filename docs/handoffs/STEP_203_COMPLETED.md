# STEP 203 — Store payment creation endpoint for online stores

Status: **complete**. Commit `STEP 203: Store payment creation endpoint for online stores` (`bdf3b3f`) on
`arena/ca936761-kd-solution-it`, branched from STEP 231's `16cc4c4`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **75 gate lines**, this STEP's gate is `lib/api/verify-store-payments.ts` at
**227 checks**, mutation-checked with **43 mutations, 40 caught** (the other three are equivalent, and named below).

## STEP

From `docs/final/STEP_PLAN_250.md:2594`:

> **203. Store payment creation endpoint for online stores**

FEATURE_LIST §20 (`:213`) owns one payment sentence and three obligations, and they decide the whole shape:
*"A public API exists for online store payments only."*, and *"Every API call requires authentication and is rate
limited and audit logged."* §8's test/live separation and §18's hosted-fields rule apply without being repeated:
the mode comes from the credential, and no card field is read, validated, stored or echoed anywhere.

There is **no UI in this STEP**. §20's screens are STEP 202's credential screen and the store's own checkout page;
what a store integrates with is an endpoint, and the store's page is not the platform's to build. The desktop and
mobile check therefore has nothing to render - the deliverable is JSON, and its two shapes (a `201` and a refusal)
are pinned in the gate and printed in the smoke table below.

## Order, and the gap this STEP sits inside

STEP 203 was implemented after STEP 231 because the earlier work jumped the queue; it is the first of the public
API's behavioural STEPs and it depends on STEP 202's pipeline exactly as that handoff described it. **STEPs 204-230
still have no handoff and no code in this tree**, so the plan's numeric order is broken by the instructions that
named 231 and then 203, and the gap is recorded here rather than smoothed over. Nothing in this STEP needs them.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/payment-fields.ts` | new | 180 | §20's store-payment vocabulary: the path, the idempotency header and its pattern and TTL, the body ceiling, the currency, the three methods, the amount bounds, the fifteen refusal rules, the four table names, the audit action, and the request and answer types |
| `lib/api/store-payments.ts` | new | 639 | The service: the header reader, the bounded body reader, the strict three-field schema, and `createStorePayment` with its claim/replay/route/write/complete flow |
| `app/api/public/v1/payments/route.ts` | new | 73 | `POST /api/public/v1/payments`, wired through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-store-payments.ts` | new | 1318 | The gate: a PostgREST-shaped fixture carrying `0033`'s and `0037`'s constraints, nine sections and 227 checks |
| `package.json` | edited | +1 script, +1 link | `check:store-payments`, and one link in the `verify` chain after `check:public-api` |
| `scripts/verify-audit.mjs` | edited | +8 | One CSRF-exemption prefix and one identity primitive, each with the paragraph that justifies it |

**No migration.** The rows this STEP writes are already described by migrations that exist: `0033` for the
idempotency key, `0037` for the payment, `0031` for the routing rules and `0029` for the providers. The next free
number stays **129**, and `node migrations/verify.ts` is unchanged at 3778 checks, 128 migrations, 99 tables.

## The endpoint, in one paragraph

A store `POST`s to `/api/public/v1/payments` with `Authorization: Bearer <key>` and `Idempotency-Key: <key>`, and a
body of at most three fields: `amount_minor`, and optionally `currency` (`USD`, and saying so is allowed) and
`payment_method` (`card`, `bank_transfer`, `e_wallet`; the default is `card`). It receives `201` with the payment's
id, `object: "payment"`, `status: "pending"`, the amount, the currency, the mode the credential was issued in, the
method and the instant the row was written - and, on a retry of the same key with the same body, the same bytes with
`idempotency-replayed: true`. It can never send `company_id`, `mode`, `status` or any other field: the schema is
strict, so such a field is refused by name rather than ignored, because a field the platform silently drops is a
field a client believes it set.

## The idempotency contract, and why the key is a header

The key is required and its absence is its own refusal (`idempotency_key_missing`), because a checkout call that
cannot be retried safely is not a checkout call. It is 8 to 128 characters of `[A-Za-z0-9._:-]`, beginning and
ending with a letter or a digit, hashed with SHA-256 into `idempotency_keys.key_hash` and never stored, echoed or
logged in clear. It lives in a header rather than in the body because it describes the request, so a client library
sets it once and a retry carries it without anyone copying it into a payload. It is claimed under scope `payment`
with `expires_at` one day out, and `request_hash` is the SHA-256 of `[amount, currency, method]`.

The four answers are the whole contract:

- **first call** - claim, route, write the payment, store the `201` body on the key, answer it.
- **same key, same request** - replay the stored body verbatim with `idempotency-replayed: true`, one payment.
- **same key, different request** - `409 idempotency_conflict`, no payment.
- **same key, attempt in flight or spent** - `409 idempotency_in_flight` or `409 idempotency_failed`, no payment.

A unique violation on the claim is not an error: it is the race the table exists to decide, so the losing writer
re-reads the winner's row and answers from it. Both unique indexes - `(company_id, scope, key_hash)` and
`payments.idempotency_key_id` - are relied on, and the fixture carries both, so a second delivery of one key cannot
become a second payment even if a writer's first read was blind.

## Routing, and what a merchant with no route is told

Routing is not re-implemented. The service reads the merchant's active rules for the credential's mode, then the
platform's (`company_id is null`) rules for the same mode, then the providers behind all of them in one
`id=in.(...)` query, drops every provider that is not `active`, cannot `supports_acceptance`, or is not a key
`lib/payments/registry.ts` knows - and hands the survivors to `routePayment`, the payment core's own engine. The
engine decides by priority, then by whether a rule's method and country match the request.

No match is not a `500` and not a silent default. §6 says a payment with no matching rule is rejected, so the key
is marked `failed: route_unavailable` and the store is told `422`. Spending the key is deliberate: the caller must
retry with a new key, which is what keeps the contract "one key, one decision" true.

## What the platform never sees

No card number, no expiry, no customer name, no address, no store name. §18 puts card entry in the provider's hosted
fields, and on this endpoint there is nowhere for a card to arrive: the schema has three fields, the body ceiling is
2 KB, the `payments` row is written with `provider_key_id` null because nothing has been sent to a gateway yet, and
the gate refuses any query the service makes that names a card column.

## What the gate proves (9 sections, 227 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration was added - the migration inventory still ends at 128 - and every column, check and index this STEP leans on is still in `0033`, `0037` and `0031`: the unique key per tenant, the key's `^[0-9a-f]{64}$` hash, the one-payment-per-key index, `provider_id not null`, the amount and currency and method and mode and status checks, the pending default, `0037`'s own comment naming the store payment, and the scope `payment` |
| 2 | The key header: eight refusals (absent, empty, whitespace, too short, a space, a character outside the set, a leading hyphen, past the ceiling) each naming `idempotency_key` and its own rule; four accepted keys including an 8-character floor and a 128-character ceiling; and surrounding whitespace trimmed rather than refused |
| 3 | The body: not-JSON, a declared `Content-Length` past the ceiling (refused before the stream is read), a body past the ceiling (`413 body_too_large`), and eleven refusals naming their field - missing amount, string amount, fractional amount, zero, below the floor, above the ceiling, another currency, an unknown method, and `company_id`, `mode` and `status` each refused as `unknown_field`. Then the floor amount accepted with `USD` and `card` filled in, and an explicit `USD`/`bank_transfer` kept |
| 4 | Creation: `201`, `object`, `pending`, the amount and currency and mode and method and timestamp; the row's company and mode from the principal rather than the body, `invoice_id` and `provider_key_id` null, the row naming its key row; the key completed with a `201` and a body to replay; the caller's key absent from the payment, the key row and the answer |
| 5 | Routing: the highest-priority rule wins and the payment names the rule; a method no card rule names falls to the general rule; a live credential is routed by live rules only; no rule at all is `422 route_unavailable` with the key spent and no payment; a platform rule serves a merchant with none of its own; a country-scoped rule cannot route a payment that names no country; a disabled provider's rule is not a route; a provider key the registry does not know is skipped; and the five registry keys are the vocabulary |
| 6 | Idempotency: same key and body = one payment replayed byte for byte from the key row; same key with another amount = `409 idempotency_conflict`; a planted `in_flight` key = `409 idempotency_in_flight`; a planted `failed` key = `409 idempotency_failed`; a blind first read that loses the insert race replays the winner instead of erroring; and two merchants using one key string are two payments |
| 7 | The chain: one `api.payment_created` per created payment with amount, mode, provider and credential, on the merchant's chain, against the payment, and no caller key in the payload; a replay writes no second entry; a lost completion write leaves the key in flight and the call successful; a payment the schema refuses spends the key |
| 8 | Through STEP 202's pipeline: `201`, no replay header on a first answer, three `public_api` counters with the limiter's own route ceiling, one `api.call` entry carrying `201`, no query naming a card field, and a full bucket refusing with `RATE_LIMITED` and writing no payment |
| 9 | The sources: the route exports `POST` and no other verb, goes through `handlePublicApiCall`, reads the key then the body then the schema then the service, is `force-dynamic`, calls no CSRF guard because a bearer key is not ambient, reads no cookie, prints nothing, names no card field, passes the answer's headers through and sets the replay header only on a replay; the service hashes the key once and writes the hash, claims before it writes, completes with the answer, routes through `routePayment`; and the vocabulary is framework-free, machine-worded and equal to the schema's own three methods |

### The mutations

Forty-three, each restored immediately, **40 caught**. They are: no key accepted; too-short, over-long and
out-of-alphabet keys accepted; the declared and the counted body ceilings lifted; a non-JSON body passed on; a
missing amount not told apart; the floor, the ceiling and the whole-number rule lifted; any currency accepted; any
method accepted; an unknown field ignored; the key stored unhashed; two bodies hashed as one request; the key
claimed as completed; an in-flight key and a spent key treated as decisions; another body replayed under one key;
the replay flag dropped; a disabled provider made usable; mode separation dropped; platform rules ignored; a country
rule made to match a request with no country; the payment written `captured`; the payment written `live`; the
payment not linked to its key; the key not spent on a refusal; the answer not stored on the key; the chain not
written; the caller's key leaked into the answer; every mode answered `live`; a refusal with no route answering
`500`; the amount floor, the key floor, the key ceiling and the body ceiling each changed in the vocabulary; and on
the route, a `GET` added, the answer's headers dropped, and the replay header dropped.

**Three findings are written down rather than hidden.**

- **First-pass misses, two of them real gate holes.** "The payment is captured" was missed because the fixture
  wrote its own `pending` rather than the value the service sent - a fixture that invents a field cannot test it.
  The fixture now validates the written status against `payments_status_check`'s own list and stores what it was
  given. "The amount floor is a dollar" was missed because the gate compared the constant to itself; the floor and
  the ceiling are now also pinned as literals, so changing either number fails.
- **Three mutations are equivalent rather than missed, and the gate now says why.** Lifting the key's minimum or its
  maximum alone changes nothing, because the pattern's `{6,126}` enforces the same 8-to-128 window; the gate gains
  two combined mutations that lift the constant *and* the pattern, and both are caught. Dropping the service's
  `isProviderKey` check changes nothing either, because `routePayment` refuses a provider the registry does not
  know - two fences, one behaviour, and the surviving fence is the tested one.
- **One needle was wrong, not the claim.** "Rules are not separated by mode" first reported NEEDLE MISSING because
  the needle carried backticks the source does not have. Corrected, it is caught - a live credential is routed by
  the live test's rules.

## Security

- **The caller's key is a secret the platform keeps the digest of.** SHA-256 into `key_hash`, one row per
  `(company, scope, hash)`, and the gate asserts the plaintext is absent from the payment, the key row, the answer
  and the chain entry. No refusal quotes the value; a refusal names a field and a rule.
- **The company and the mode come from the credential.** The body has no field that can reach either, `strictObject`
  refuses a request that tries, and the payment row is written with the principal's company and mode. A request
  cannot create a payment in another merchant's account by naming one.
- **An amount is bounded twice.** The service refuses below 50 minor units, above 10,000,000, and any fractional
  value; `payments_amount_check` and the currency check are the second fence, and both are exercised.
- **A retry cannot double-charge.** The key is claimed before a payment is written, the payment names the key
  through a unique index, and every decision is recorded on the key so a second delivery replays the first answer
  rather than repeating the work.
- **Nothing routes to a provider that cannot take it.** Disabled, deleted, non-accepting and unknown providers are
  dropped before the engine decides, and no rule at all is a `422` with the key spent - never a default provider.
- **No card data, anywhere.** No field of the body, no column written, no query made and no answer field names a
  card; §18's hosted fields remain the only place a card is typed, and this endpoint cannot receive one.
- **Every call is counted and recorded.** STEP 202's pipeline runs before the handler: a refused key never reaches
  the body reader (proved on a running server, below), the limiter's three buckets are consumed before a payment is
  written, and both the call and the creation are in the chain with no key in either.
- **The CSRF rule was extended, not weakened.** `scripts/verify-audit.mjs` now names `app/api/public/v1/` as a
  CSRF-exempt prefix - a store sends a bearer key and no cookie, so there is no ambient credential for a cross-site
  request to borrow - and names `handlePublicApiCall` as an identity primitive, which is the function that refuses
  with `401` before the route's handler is called. The exemption list is still three entries long, under the gate's
  own cap, and each entry carries the paragraph that justifies it.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean - `/api/public/v1/payments` listed as a dynamic route (ƒ)
npm run check:store-payments      227 checks
npm run verify                    exit 0, 75 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3228 messages, 343 placeholders (unchanged: no user-facing string)
node scripts/verify-structure.mjs 785 source files (four new)
node scripts/verify-audit.mjs     4457 checks (4429 before: the new route is walked with its two exemptions)
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1
(`auth/device-proof-store`), `lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3405 with the placeholder environment STEP 199 recorded (the two Supabase keys lengthened past
the 32-character boot minimum - the first start was refused by environment validation, which is the guard doing its
job). No database is reachable in this sandbox, so the two outcomes that need one - a `201` and a replay - are
proved in the gate's fixture instead, and the table below is what a real boot can show.

| Request | Answer |
| --- | --- |
| `POST /api/public/v1/payments` with a body and no `Authorization` | `401 AUTHENTICATION_REQUIRED`, `cache-control: no-store, max-age=0` |
| The same with no `Idempotency-Key` either | `401` - the key is authenticated before a byte of the body is read |
| The same with `Authorization: Bearer nope` | `401` - refused on the header's shape, no credential lookup attempted |
| The same with a well-shaped but unknown `kd_test_main_…` key | `502 DEPENDENCY_FAILED` - shape passed, so the call reached the credential lookup and the absent database answered; this is the ordering proof, not a defect |
| A 3 KB body with no `Authorization` | `401` - authentication precedes the size refusal |
| `GET /api/public/v1/payments` | `405` |
| `DELETE /api/public/v1/payments` | `405` |
| `next build` route table | `ƒ /api/public/v1/payments` |

`.env.local` was deleted afterwards (checked: absent) and the server was killed by pid.

## Carried gaps (named rather than hidden)

1. **No `checkout_url`, because no schema holds one.** `grep -rn "checkout_url\|checkoutUrl" migrations/ lib/ app/`
   returns nothing: there is no column, no adapter field and no port for a gateway's hosted page in this tree. So a
   created payment is a `pending` row and the store has nothing to send its customer to yet. The charge STEP that
   opens the provider session is the one that adds it - and it is the STEP that also fills `provider_key_id`. This is
   the single largest thing between this endpoint and a working checkout, and it is not faked here.
2. **A country-scoped routing rule can never serve a store payment.** The request names no country, the body has no
   field for one and `payments` has no column to keep it, so `routePayment` - correctly - never matches
   `country_code`-bearing rules. A merchant whose only rules are country-scoped is told `route_unavailable`. The
   gate pins this behaviour so it cannot drift silently; the fix is a field, and a field is a later STEP's decision
   rather than something to invent here.
3. **No CORS.** STEP 202's gap, unchanged, and it now bites harder: a browser-based checkout cannot call this
   endpoint from the store's own origin, so integration today is server-side. The headers belong to the STEP that
   decides which origins a merchant may register.
4. **The `api.payment_created` entry records no client address.** The `api.call` entry STEP 202 writes for the same
   request carries one, and the creation entry carries what was created instead of repeating it. Worth revisiting
   when a store can act from a browser, where the address is less stable and less useful.
5. **A `route_unavailable` spends the key.** Deliberate - one key, one decision - and the store must mint a new key
   after the merchant fixes their routing. A store that retries with the same key gets `409 idempotency_failed`,
   which is the honest answer and not the one a naive client expects.
6. **The 401 body is dashboard copy and carries no `x-api-version`.** STEP 202's gap, unchanged: a refused call is
   answered before the pipeline builds an answer, so the version header and a public-API-worded body arrive with the
   STEP that gives the surface its own error copy.
7. **A merchant still cannot mint a usable key from the product.** STEP 202's credential screen issues one, but the
   key is shown once and the merchant portal's end-to-end flow is not built; this endpoint is provable by test and
   by fixture, not yet by a customer.
8. **STEPs 204-230 are absent from this tree.** Reading a payment (the natural `GET` beside this `POST`), listing,
   webhooks and the store's own onboarding all live in that range, which is why this route answers `405` for every
   verb but `POST`.
