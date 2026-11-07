# STEP 206 — Merchant test credentials and sandbox payment simulation

Status: **complete**. Commit `STEP 206: Merchant test credentials and sandbox payment simulation` (`233fb79`) on
`arena/ca936761-kd-solution-it`, branched from STEP 205's `3034631`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **78 gate lines**, this STEP's gate is `lib/api/verify-sandbox-simulation.ts` at
**422 checks**, mutation-checked with **39 mutations, 39 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2630`:

> **206. Merchant test credentials and sandbox payment simulation**

FEATURE_LIST §8 (`:107`) owns it, and its five lines are the whole specification:

> Every merchant has a Test and Sandbox mode with separate test credentials. · Test payments move no real money. ·
> Invoices, payment links, recurring invoices and store connections can all be exercised in test mode. · Test and
> live data are fully separated. · Simulated webhooks let the merchant verify an integration.

The last line is **STEP 207's** surface, and this STEP never claims it. Everything else is here. §8's test-mode
sentence is why a store can build an integration before it has a merchant account, a card or a gateway: STEP 203
creates the payment, STEP 204 reads it, and this STEP is the call that moves it to an outcome without a processor.

There is **no UI in this STEP**: §20's screens belong to the credential STEP, and what a store integrates with is an
endpoint. The desktop and mobile check has nothing to render; the deliverable is a delivery, and the smoke run below
is what "exercised" means.

## Order, and the gap this STEP sits inside

Implemented immediately after 205 at the owner's instruction. **STEPs 207-230 still have no handoff and no code in
this tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing in
206 depends on the missing range: it depends on 202's pipeline, 203's created payment, 204's answer shape and
`0034`/`0037`'s columns.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/sandbox-fields.ts` | new | 221 | The vocabulary: the route template, the three scenario words, the patch table, the write columns, the rules, the audit actions and the read/read-back column lists |
| `lib/api/sandbox-payment.ts` | new | 485 | The service: the credential fence, the body reader, the request parser, the compare-and-set simulation, the two chain entries and the STEP 204 shaped answer |
| `app/api/public/v1/payments/[id]/simulate/route.ts` | new | 86 | `POST /api/public/v1/payments/{id}/simulate`, wired through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-sandbox-simulation.ts` | new | 1380 | The gate: a PostgREST-shaped fixture that applies writes and can lose a race, eleven sections and 422 checks |
| `package.json` | edited | +1 script, +1 link | `check:sandbox`, and one link in the `verify` chain after `check:store-webhooks` |

Ownership follows `STEP_PLAN_250.md:120` — API and Plugin STEPs 200-211 own `app/api/public/` and `lib/api/`.
`package.json` is the integrator-owned shared file, touched for one script and one chain link and nothing else.

**No migration.** `0034` already separates test from live by `mode`, and `0037` already holds every column a
simulation writes. The next free number stays **129**, and the migration gate is unchanged at 3778 checks,
128 migrations, 99 tables.

## The call, in one paragraph

A store that created a `pending` payment with a **test** key sends `POST /api/public/v1/payments/{id}/simulate` with
one field — `{"scenario":"captured"}`, `declined` or `review` — and receives `200` with the payment, shaped exactly as
STEP 204 serves it, in the state the scenario names. A second simulation of the same payment answers `409`, because a
payment a scenario has already decided is not a payment to rewrite.

## The three scenarios, and what each one writes

| Scenario | `payments.status` | The rest of the patch |
| --- | --- | --- |
| `captured` | `captured` | `authorized_at` and `captured_at` at one instant, `three_ds_outcome = 'authenticated'` |
| `declined` | `failed` | `failed_at`, `failure_code = 'card_declined'`, `failure_detail = null` |
| `review` | `under_review` | `risk_decision = 'review'` |

Two of those deserve a sentence. **The capture records an authentication** because `0037`'s
`payments_three_ds_capture_check` refuses a captured payment that is neither authenticated nor accompanied by matching
postal-code and IP-country evidence — and a test payment has no evidence to offer, so the simulated provider's answer
is the authenticated one. Nothing else is invented: the postal and IP flags are untouched, no
`provider_transaction_id` is written, and the row's `mode` stays `test` where every reader can see it. **The decline
records nothing but a code**, because section 18 keeps a processor's free sentence out of the platform's tables and
`0037` requires one exactly when the payment failed.

The patch table is why *"test payments move no real money"* is a property of the code: across all three scenarios,
`amount_minor`, `currency`, `fee_minor`, `net_minor`, `platform_fee_minor`, `refunded_minor`, `refunded_at`,
`settled_at`, `provider_transaction_id`, `card_brand`, `card_last_four` and the two risk-evidence flags are never
named — and the gate asserts exactly that, column by column, for every scenario.

## The two fences, and why the mode is a literal

**The credential fence.** A live key is refused `403 PERMISSION_DENIED { field: "authorization", rule:
"live_credential_not_simulable" }` **before the body is read and before a single query** — that is what section 8's
"separate test credentials" buys, because the mode is inside the key (`kd_test_…` / `kd_live_…`), STEP 202 proved the
key, and the mode it proved decides whether this surface exists for this caller.

**The literal fence.** Every query of the service says `mode=eq.test` as a **constant**, never splicing the
principal's mode. Two independent facts therefore have to fail before a live row is touched, and the gate proves the
query string itself says `test` — so removing either fence in a refactor leaves the other standing.

## Why the write is a compare-and-set

Two simulations reaching one payment at once must not both land. The service reads the row with its `version`, filters
the update on that version, and reads back — and the read-back requires **both** the version to have advanced by
exactly one *and* the row to hold the scenario's status. The second half matters: a version that moved by one is not
proof on its own, because a concurrent winner bumps it just as this writer would. A lost race answers
`409 { field: "payment", rule: "simulation_race" }` rather than reporting a success the row does not hold. The idiom is
the platform's own (`lib/announcements/service.ts` writes its rows the same way).

Three queries and one write is the whole of it: the row with its version, the update, the read-back that both proves
the write and supplies the answer. No ledger row, no fee, no provider call, no webhook — and the gate counts the reads
and the writes so a fourth query is a red gate.

## What the gate proves (11 sections, 422 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration (128, 99 tables), and every `0037` constraint the write has to satisfy: `under_review` in the status list, the three-dimensional-secure capture rule, the failed/code and failed/instant pairs, the risk rule, the refunded-total guard and the version column — plus `0034`'s mode check and its own comment naming section 8 |
| 2 | Test credentials: the key carries the mode visibly, a third mode word is not a key the platform issues, a live principal is `403` with the named field and rule and **zero queries**, a test principal passes both the predicate and the guarding fence without writing, and the service refuses a live credential before its first read and leaves the row where it was |
| 3 | The literal mode fence: the first read selects status and version, narrows on `mode=eq.test`, the company, `invoice_id is.null`, `deleted_at is.null` and `limit=1`, and never on a star — and the read-back is STEP 204's ten columns plus `version` |
| 4 | The scenario table: three frozen words and nothing else; each patch's exact columns and values at a fixed instant; a capture's two instants identical; a decline's code and null detail; a review's waiting decision; and, for every scenario, the thirteen money/identity/value columns that must not appear |
| 5 | The request: three words accepted; ten refusals with their own rule (missing, unsupported, upper case, padded, empty, numeric, array, null, bare string, unknown field); a body that is not JSON; a declared length past the ceiling and an undeclared body past it, both `413`; and a body inside the ceiling read |
| 6 | The write: one write, to the payment table, filtered on the version read **and** on the literal test mode, carrying exactly the scenario's four columns; the row moved; the amount, the provider transaction and the evidence flags untouched; the version advanced; and the answer's eleven keys are STEP 204's ten fields in its order with the object name |
| 7 | The other two scenarios end to end, the fixture's second payment untouched, and the three scenarios ending in three different states |
| 8 | Seven malformed ids refused with STEP 204's field and rule and **no query**; five kinds of "not yours" (unknown, another merchant's, a live-mode payment, an invoice payment, a deleted one) all `404` with one rule and one chain entry naming the id; a decided payment `409 payment_already_decided`; a lost race and a vanished row both `409 simulation_race` with the row unmoved |
| 9 | The chain: the success entry's action, entity, id, null actor and session, company, address, scenario, both statuses, mode and credential — and never the key, an amount or a card field; every refusal recorded; and a deaf trail that neither fails a simulation nor lets a live credential through |
| 10 | Through the pipeline: `200` with `x-api-version`, `cache-control: no-store` and no replay header, one body read, three counters and one `api.call` entry recorded under the **template**; a live key that is `403` before a body read and before any payment query while the call is still recorded; and a full bucket refusing before the handler |
| 11 | The sources: `POST` and no other verb, `force-dynamic`, awaited params, the pipeline, the fence **before** the body read, no cookie, no CSRF, no idempotency key, nothing printed; the service's one write, two reads and no insert; the route template, the concrete path, and every rule and action a machine word |

### The mutations

Thirty-nine, each restored immediately, **39 caught**. They are: a fourth scenario; a capture recording no
authentication; the decline code turned into a scenario word; a review rejecting the payment; the capture's two
instants drifting apart; a decline with no instant; an `authorized` payment made simulable; a decline and a review
writing their own words instead of the schema's; the body ceiling raised to a megabyte; a renamed decided rule and a
renamed audit action; the route's own segment renamed; a patch writing the amount; a read-back forgetting the version;
a read selecting a card column; a live credential made simulable; the guarding fence removed; each of the three query
fences dropped (`mode`, invoice, deleted); the read asking for every row; the write losing its compare-and-set; a lost
race reported as success; the status half of the read-back check removed; not-found answered as a permission error; a
decided payment answered as a validation failure; the id not validated; a refusal with no entity; the success entry
naming the wrong destination and no scenario; a non-strict request schema; an unsupported scenario accepted; an
unbounded declared body; a malformed body returned instead of refused; the service trusting its caller; the route
reading the body before the fence; the route recording the arriving path; and a second verb on the route.

One miss in the first round was worth fixing in the **gate**, not the code: "the route reads the body before fencing"
removed the fence call entirely, and the source check compared two `indexOf` values — `-1` sorted before everything.
The check now requires the call to be present *and* to precede the body read. A second candidate mutation was dropped
rather than chased: inverting the guarding fence to `mode !== "live"` changes nothing observable, because `test` and
`live` are the only two modes and both branches refuse a live key.

## Security

- **Validation** — the credential before the body, the body bounded twice and parsed strictly, the scenario checked
  against a frozen list, the id checked by STEP 204's parser, and the state checked against the one status a
  simulation may start from. Every refusal names a rule and never the value.
- **RLS** — one credential read through STEP 202's client, then two reads and one write narrowed by `company_id`; the
  table's policies are untouched and the response never leaves the tenant's own row.
- **The mode fence** — the credential's mode decides the surface, and the SQL says `test` in three places, so test
  and live data cannot mix even if one of the two fences is removed.
- **The chain** — `api.sandbox_payment_simulated` on every landed simulation with the scenario, both statuses, the
  mode and the credential; `api.sandbox_simulation_refused` on every refusal with the rule; `api.call` (STEP 202) on
  every call, including the ones this handler refuses. No entry carries the key, an amount or a card field.
- **Money** — the patch table cannot name a money column, the service writes one table, and no ledger, fee,
  settlement or provider row is touched: *"Test payments move no real money"* is enforced where it can be read.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-sandbox-simulation.ts` | exit 0 — "sandbox simulation gate passed: 422 checks" |
| `npm run verify` | exit 0 — **78 gates**, including the unchanged checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 796 source files, audit 4534 |
| `npm run build` (inside `verify`) | ✓ compiled; the route table lists `ƒ /api/public/v1/payments/[id]/simulate` |
| Mutation round | 39 mutations, **39 caught** |

The smoke ran the production build against the placeholder environment of `.env.example` (`npx next start -p 3406
-H 0.0.0.0`, since removed), with no database behind the placeholder URL:

```
POST {id}/simulate, no key          → 401 AUTHENTICATION_REQUIRED            (refused at the pipeline)
POST {id}/simulate, "Bearer nope"   → 401 AUTHENTICATION_REQUIRED            (malformed, no query)
GET  {id}/simulate                  → 405                                   (the framework's, one verb)
POST {id}/simulate, kd_test_… key   → 502 DEPENDENCY_FAILED, retryable       (no database behind the placeholder)
```

The 502 is the honest answer to a test key that is well formed when the credential lookup cannot reach a database: the
route turns a dependency failure into a retryable `502` rather than a `500` page, and the 401s prove the three
responses that need no database at all. The endpoint's real behaviour — the three scenarios, the fences, the
compare-and-set — is proven by the gate, which drives the same service and the same pipeline in process.

## Carried gaps (named rather than hidden)

1. **Nothing schedules a webhook after a simulation.** §8's *"simulated webhooks let the merchant verify an
   integration"* is STEP 207's surface, and STEP 205's delivery still needs an endpoint no table holds. A simulation
   therefore moves a payment and writes a chain entry, and the store learns about it by reading STEP 204's endpoint.
2. **A simulation is not idempotent by key.** A retried `POST` on a decided payment answers `409` rather than the
   first answer. That is deliberate — a simulation is not a charge — but a client that wants replay semantics must
   read the status instead.
3. **Only `pending` can be simulated.** No call in this API produces `authorized`, so there is nothing to move from
   that state; a store that needs a two-step authorization flow has no way to exercise it here.
4. **The fixture is in-memory.** The gate proves the queries and the patch, not PostgREST's own behaviour; a schema
   drift that a real database would refuse (`payments_three_ds_capture_check`, the failure pair) is pinned against
   `0037`'s text rather than against a live constraint.
5. **There is no merchant-facing screen for any of this.** Issuing the test key is STEP 201's settings screen and
   reading a test payment is STEP 204's endpoint; this STEP adds the one call in between, and no UI.
