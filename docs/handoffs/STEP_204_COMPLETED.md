# STEP 204 — Store payment status endpoint

Status: **complete**. Commit `STEP 204: Store payment status endpoint` (`b2bb310`) on
`arena/ca936761-kd-solution-it`, branched from STEP 203's `0ca537d`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **76 gate lines**, this STEP's gate is `lib/api/verify-store-payment-status.ts` at
**214 checks**, mutation-checked with **31 mutations, 31 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2606`:

> **204. Store payment status endpoint**

FEATURE_LIST §20 (`:213`) is the section that owns it. The two sentences that decide this STEP are *"A public API
exists for online store payments only."* and *"Every API call requires authentication and is rate limited and audit
logged."* §8's test/live separation and §18's hosted-fields rule carry over unchanged: the mode comes from the
credential, and no card field is read, selected, stored or served.

The endpoint exists because STEP 203 answers `pending`. A card is charged later, on the provider's own hosted
fields, so the store has to ask again - and asking again needs a contract rather than a table the store is trusted
to read.

There is **no UI in this STEP**, for the same reason as 203: §20's screens belong to the credential STEP, and what a
store integrates with is an endpoint. The desktop and mobile check therefore has nothing to render; the deliverable
is JSON, and both of its shapes are pinned in the gate and printed in the smoke table below.

## Order, and the gap this STEP sits inside

Implemented immediately after 203 at the owner's instruction. **STEPs 205-230 still have no handoff and no code in
this tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. STEP 204
depends on STEP 202's pipeline and STEP 203's vocabulary and on nothing in the missing range.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/store-payment-status.ts` | new | 299 | The read's vocabulary and its service: the route template, the id pattern and ceiling, the two refusal rules, the nine states, the ten selected columns, the view type and `readStorePaymentStatus` |
| `app/api/public/v1/payments/[id]/route.ts` | new | 71 | `GET /api/public/v1/payments/{id}`, wired through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-store-payment-status.ts` | new | 868 | The gate: a PostgREST-shaped fixture over the credential, company and payment rows, nine sections and 214 checks |
| `package.json` | edited | +1 script, +1 link | `check:store-payment-status`, and one link in the `verify` chain after `check:store-payments` |

Ownership follows `STEP_PLAN_250.md:120` - API and Plugin STEPs 200-211 own `app/api/public/` and `lib/api/`.
`package.json` is the integrator-owned shared file, touched for one script and one chain link and nothing else.

**No migration.** `0037` already holds every column the answer reads. The next free number stays **129**, and the
migration gate is unchanged at 3778 checks, 128 migrations, 99 tables.

## The endpoint, in one paragraph

A store `GET`s `/api/public/v1/payments/{id}` with `Authorization: Bearer <key>` and no body, and receives `200` with
the payment's id, `object: "payment"`, its status, its amount, what has been refunded, the currency, the mode, the
method, the processor's machine failure code or null, and the two instants (created, last moved) - ten fields, all
scalars. It sends no idempotency key and is not asked for one: a `GET` delivered twice reads the same row twice, and
the second read is a poll rather than a mistake. The header is not read at all, so a client that sends one anyway is
not refused for it.

## Three refusals, and why the answers are this coarse

- **`422 payment_id_malformed`** - the path segment is not a lower-case UUID. It costs no query, and it is the one
  case where the answer is about the request: a store that built `/payments/abc` has a bug, and telling it so saves
  it a support ticket. The value is bounded at 64 characters before a regular expression sees it, and a value that
  is not a string at all is refused by the same rule.
- **`404 payment_not_found`** - five different states are **one** answer: an id that does not exist, another
  merchant's id, a test payment asked for with a live key, an invoice payment, and a deleted payment. Telling them
  apart is telling a stranger which of their guesses was close.

Nothing else can come back. There is no `403`, because a payment that is not yours does not exist for you; there is
no `304`, because a payment status is the one answer in this API that is never allowed to be stale; and no failure
of the handler can be a `200`.

## The fence that makes this "store payments only"

§20's first line says the public API is for online store payments. `0037` already defines the term, in a column
comment: *"The invoice this payment settles, or null for a store payment that has no invoice yet."* So the read
narrows on `company_id`, on `mode`, on `deleted_at is null` and on `invoice_id is null` - four conditions on one
primary-key lookup. A merchant's invoice payments are not reachable through the public API at all, which is the
section's sentence implemented rather than restated.

## Why the pipeline is given a template, not the path that arrived

`API_PAYMENT_STATUS_ROUTE` is `/api/public/v1/payments/{id}`. The limiter keys its route bucket on the route string,
so passing the concrete path would give every payment its own sixty-a-minute allowance and let one merchant multiply
their budget by polling a thousand ids. The template keeps the endpoint's ceiling the endpoint's. The cost is
recorded as a gap below: STEP 202's call entry then names the route rather than the resource.

## What is in the chain, and what deliberately is not

STEP 202's `api.call` entry is written for every call - route, status, mode, key tail, address - and that is the
audit §20 asks for. A **served** read adds nothing: a store polls, and a chain entry per poll would turn a five
second poll into a write amplifier for a decision nobody made.

A **refused** read is different, because it names a payment the caller was not entitled to see, and an id being
probed is exactly what someone will want to read back later. So `api.payment_read_refused` is written with the id
(when it is a well formed one and null otherwise), the rule, the mode and the credential, on the merchant's chain,
with the caller's address - and never the caller's key. It is written best effort: the gate proves that a chain
which cannot be written neither allows a refused read nor fails a served one.

## What the gate proves (9 sections, 214 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration was added - the inventory still ends at 128 - and every fact this read leans on is still in `0037`: the column comment that defines a store payment, both halves of the status list, the refunded invariants (`<= amount`, a full `refunded` means the whole amount), `updated_at >= created_at` and the method vocabulary |
| 2 | The id: nine malformed values refused with `422`, the field `id` and `payment_id_malformed`; a value exactly at the length ceiling looked at and then refused by the pattern; a non-string refused by the same rule without ever reaching `trim`; a lower-case version 7 id accepted; and surrounding whitespace trimmed rather than refused |
| 3 | The answer: the key set is exactly ten names; every one of the nine states is served as its own state with its own refunded total and failure code; a USD row reads `USD`; a **EUR** row reads `EUR`, because rule 2 is enforced where money is written rather than by a read that lies; the ceiling amount is a number and not a string; and no answer carries a card field, the company id, the processor's transaction id or its free text sentence |
| 4 | The query: one read is one query; it narrows on id, company, mode, `invoice_id is.null`, `deleted_at is.null` and `limit=1`; it selects the ten named columns, never a star, and never a card, failure-detail, provider-transaction or fee column; and the column constant is pinned to the answer's field list |
| 5 | The five kinds of "not yours" (unknown, another tenant, another mode, an invoice payment, a deleted row) are each a `404 RESOURCE_NOT_FOUND` with the same field and rule, each writes exactly one refusal entry naming the id, and a malformed id is a `422` that reaches the table **zero** times and still lands in the chain with a null entity |
| 6 | The chain: the refusal entry's action, chain, null actor, address, mode and credential; the caller's key absent from it; a served read writing nothing at all here; and a deaf trail neither allowing a refusal nor failing a read |
| 7 | Through the pipeline: `200` with `x-api-version: v1`, `cache-control: no-store` and no replay header; three counters (the route one at the limiter's own ceiling) and one call entry whose route is the **template**; a read with an idempotency header still served; a `404` that still writes its call entry beside the refusal entry; and a full bucket refusing before the table is touched |
| 8 | The sources: the route exports `GET` and no other verb, goes through `handlePublicApiCall`, passes the template, awaits the params, hands the address to the service, is `force-dynamic`, reads no idempotency key, no body, no cookie and no CSRF token, prints nothing, names no card field and returns the answer's status and headers; and the service narrows on the invoice fence, the deleted fence and the credential's mode |
| 9 | The vocabulary: the route template is STEP 203's path with `{id}` unbound, a payment's own path encodes its id, every rule and state is a machine word, the state list keeps the schema's order and its nine members, and the refusal action is `api.payment_read_refused` and matches the chain's dotted pattern |

### The mutations

Thirty-one, each restored immediately, **31 caught**. They are: a non-uuid queried with; a non-string id not guarded;
the id's shape not enforced (the pattern replaced by `/.+/`); the id not trimmed; the tenant dropped from the query;
the mode dropped; the invoice fence dropped; the deleted fence dropped; `limit=1` dropped; a missing payment answered
as a validation failure; a malformed id answered as a `404`; the malformed probe not recorded; the refused read not
recorded; the refusal recording no id; a chain that cannot be written failing the read; the answer assuming USD; the
failure code dropped; the refunded total dropped; every payment answered `pending`; the last movement replaced by
the first; a card field added to the answer; the company added to the answer; a card column added to the select
list; the refusal action renamed to a word that is not dotted; a state removed from the list; the route template
changed to `:id`; and on the route: a `POST` added, the answer's headers dropped, the concrete path counted instead
of the template, an idempotency-key read introduced, and the address dropped.

**Two findings are written down rather than hidden.**

- **The first pass reported three misses and only one was about the gate's reach.** "A value past the ceiling is
  looked at" and "an empty segment is queried with" are **equivalent** mutations: the pattern already refuses both,
  so lifting either guard alone changes no answer. The ceiling and the emptiness check exist to bound work before a
  regular expression runs, not to change a refusal. The gate now carries the mutation that matters - the pattern
  itself replaced by `/.+/` - and that one is caught, which is what proves the id's shape is load-bearing.
- **The third was an incomplete mutation, and it exposed a real hole.** "A malformed id is a `404`" reported missed
  because the file contains the same throw twice - once for a non-string value and once for a bad string - and the
  harness replaces only the first. Applying both by hand turns the gate red, which is the right answer; but the gate
  had been testing only the string path, so the non-string branch was never exercised. It now is: a `null` id is
  refused by the same rule without reaching `trim`, and the "a non-string id is not guarded" mutation is caught.

## Security

- **Four conditions on one lookup.** Tenant, mode, the invoice fence and the deleted fence are in the query, not
  applied afterwards, so a row that is not the caller's is never read into the process at all.
- **Five states, one answer.** A `403` would confirm that an id exists and is somebody else's; this endpoint answers
  `404` for every kind of "not yours", and the gate asserts each case separately so the collapse cannot silently
  become five different messages.
- **The id is bounded before it is matched.** 64 characters, then a lower-case UUID pattern, then a query. A path
  segment is caller-controlled and can be a kilobyte; a regular expression is not the place to discover that.
- **The answer carries the money and nothing else.** No card brand or last four, no processor transaction id, no
  `failure_detail` (a processor's free sentence about a customer), no fee the platform kept, no company id. The
  select list is ten named columns and the gate pins it, so a future `select=*` cannot arrive quietly.
- **A refusal is attributable, a poll is not amplified.** `api.payment_read_refused` names the id, the rule, the
  credential and the address and never the caller's key; a served read writes nothing beyond the pipeline's call
  entry, so a store polling every five seconds does not turn the chain into a write amplifier.
- **The pipeline still owns the surface.** Authentication before the handler, all three limiter buckets consumed
  before a row is read, `api.call` for every status including the refused ones, and `no-store` on every answer -
  the gate pins that a full bucket refuses with the table untouched.
- **No mutation, so no CSRF.** A `GET` changes nothing and carries no token; the route is asserted not to import the
  guard, and the audit gate's CSRF rule does not apply to a non-mutating route at all.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean - `/api/public/v1/payments/[id]` listed as a dynamic route (ƒ)
npm run check:store-payment-status 214 checks
npm run verify                    exit 0, 76 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3228 messages, 343 placeholders (unchanged: no user-facing string)
node scripts/verify-structure.mjs 788 source files (three new)
node scripts/verify-audit.mjs     4478 checks (4457 before: the new route is walked)
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3405 with the placeholder environment STEP 199 recorded. No database is reachable in this
sandbox, so a `200` with a real row and the four-kind `404` are proved in the gate's fixture; the table below is what
a real boot can show.

| Request | Answer |
| --- | --- |
| `GET /api/public/v1/payments/{id}` with no `Authorization` | `401 AUTHENTICATION_REQUIRED`, `cache-control: no-store, max-age=0` |
| The same with `Authorization: Bearer nope` | `401` - refused on the header's shape, no credential lookup attempted |
| The same with a well-shaped unknown `kd_test_status_…` key | `502 DEPENDENCY_FAILED` - the shape passed, so the call reached the credential lookup and the absent database answered; an ordering proof, not a defect |
| `GET /api/public/v1/payments/not-a-uuid` with no key | `401` - authentication precedes the id's validation, as it must |
| `GET` with an `Idempotency-Key` header and a bad bearer | `401` - the header is not read, and sending it changes nothing |
| `POST /api/public/v1/payments/{id}` | `405` |
| `PUT` / `DELETE` on the same path | `405` / `405` |
| `next build` route table | `ƒ /api/public/v1/payments` and `ƒ /api/public/v1/payments/[id]` - the collection's `POST` and the resource's `GET`, side by side |

`.env.local` was deleted afterwards (checked: absent) and the server was killed by pid.

## Carried gaps (named rather than hidden)

1. **Nothing yet moves a payment out of `pending`.** STEP 203 creates the row and this STEP reads it, but the charge
   against a gateway, the provider's webhook and the ledger posting are later STEPs (205 and the adapter range). A
   store that integrates today would poll and see `pending` forever. This is the largest gap between the public API
   and a working checkout, and it is not simulated away here.
2. **Still no `checkout_url`.** STEP 203's gap, unchanged: the answer is a payment, not a place to send a customer.
   When the charge STEP can open a provider session, the field arrives with it and this endpoint starts serving it.
3. **A served read cannot be attributed to a payment from the chain alone.** The call entry names the route
   template, not the resource, because the template is what keeps the limiter's bucket the endpoint's. Refusals
   carry the id; successes do not. Closing this properly means STEP 202's call entry gaining a resource column,
   which is a change to a shared file rather than something to bolt on here.
4. **A stolen key writes to the merchant's chain.** `api.payment_read_refused` lands on the merchant's chain because
   the caller authenticated as that merchant. The volume is bounded by the limiter, but a merchant who loses a key
   will see probing in their own chain - which is the honest place for it.
5. **No conditional read.** Every poll is a full row read and a full call entry; an `ETag` or `If-None-Match` over
   `updated_at` would cut both, and §17's caching guidance does not apply to a status that must be fresh. Recorded
   as a performance opportunity rather than a defect.
6. **The 401 body is dashboard copy and carries no `x-api-version`.** STEP 202's gap, unchanged and visible on this
   route too: a refused call is answered before the pipeline builds an answer, so the version header and a
   public-API-worded body arrive with the STEP that gives the surface its own error copy.
7. **No CORS, and a merchant still cannot mint a usable key from the product.** STEP 202/203's gaps, unchanged. A
   browser checkout cannot call this from the store's origin, and the end-to-end path is still proved by fixture
   rather than by a customer.
8. **A country-scoped routing rule still cannot serve a store payment.** STEP 203's gap, unchanged: the request
   names no country and `payments` has no column for one.
9. **STEPs 205-230 are absent from this tree.** STEP 205 - webhook delivery to the merchant's store - is what a
   serious integration would rather have than polling, and it will need the same identity, the same limiter class
   and its own chain entries; nothing about this STEP's shape blocks it.
