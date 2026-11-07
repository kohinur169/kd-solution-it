# STEP 207 — Simulated webhook sender for merchant testing

Status: **complete**. Commit `STEP 207: Simulated webhook sender for merchant testing` (`d467b91`) on
`arena/ca936761-kd-solution-it`, branched from STEP 206's `8fcb164`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **79 gate lines**, this STEP's gate is `lib/api/verify-sandbox-webhook.ts` at
**382 checks**, mutation-checked with **36 mutations, 36 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2642`:

> **207. Simulated webhook sender for merchant testing**

FEATURE_LIST §8 (`:107`) is the section, and this STEP is its last line:

> Simulated webhooks let the merchant verify an integration.

§8's other four lines decide *how* it is done: a merchant's separate test credential is the only key that may ask for
one, a test payment is the only thing whose event may be sent, and test and live data stay apart. §20's outbound half -
the webhook STEP 205 delivers - is what is being simulated, so a store that verifies this delivery has verified its
production path rather than a rehearsal of it.

There is **no UI in this STEP**: §20's screens belong to the credential STEP, and what a store integrates with is an
endpoint and a signature. The desktop and mobile check has nothing to render.

## Order, and the gap this STEP sits inside

Implemented immediately after 206 at the owner's instruction. **STEPs 208-230 still have no handoff and no code in
this tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing in
207 depends on the missing range: it depends on 205's delivery, 206's fences and STEP 202's pipeline.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/sandbox-webhook-fields.ts` | new | 149 | The vocabulary: route template, path builder, the five-second deadline, the body ceiling, the request and answer shapes, the six rules that describe a store's endpoint, the refusal rules and both audit actions |
| `lib/api/sandbox-webhook.ts` | new | 495 | The service: the credential fence, the body reader and request parser, the test-mode payment read, the event derivation, the observed delivery and its verdict, and the two chain entries |
| `app/api/public/v1/payments/[id]/webhook-test/route.ts` | new | 88 | `POST /api/public/v1/payments/{id}/webhook-test`, wired through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-sandbox-webhook.ts` | new | 1425 | The gate: a PostgREST-shaped fixture, a recording transport, a real `fetch` double and twelve sections of 382 checks |
| `package.json` | edited | +1 script, +1 link | `check:sandbox-webhook`, and one link in the `verify` chain after `check:sandbox` |

Ownership follows `STEP_PLAN_250.md:120` — API and Plugin STEPs 200-211 own `app/api/public/` and `lib/api/`.
`package.json` is the integrator-owned shared file, touched for one script and one chain link and nothing else.

**No migration.** The delivery reads the same two tables a real one does. The next free number stays **129**, and the
migration gate is unchanged at 3778 checks, 128 migrations, 99 tables.

## The call, in one paragraph

A merchant holding a **test** key calls `POST /api/public/v1/payments/{id}/webhook-test` with one field — the endpoint
to deliver to — and the platform sends **the payment's current event** there: the same envelope STEP 205 sends, the
same four headers, the same `x-kd-signature` computed with that credential's own signing secret. The answer says what
the endpoint did: the event id, its type, the store's own HTTP status and STEP 205's rule for it.

## What is reused, and what deliberately is not

Reused, unchanged, from STEP 205 — because a simulation that built its own bytes would be a test a store could pass
while production failed: the envelope and its field order, the serialiser and its sixteen-kilobyte ceiling, the HMAC
scheme (`t=<sec>,v1=<hex>`), the four delivery headers, `requireStoreWebhookEndpoint`, the transport
(`redirect: "manual"`, `cache: "no-store"`, an abort signal, the body never read), the status classifier, the credential
read and the per-tenant secret open, and `deliverStoreWebhook` itself.

Not reused: **205's control flow.** A queued delivery throws a retryable error so the queue can schedule another
attempt; this call has no queue, no retry and no job, and a store whose endpoint timed out is a **result to report**.
So the attempt is made with an attempt ceiling of one, and the transient throw is read back into a rule:

| The store did | Answer | `delivered` | `rule` |
| --- | --- | --- | --- |
| `2xx` | `200` | true | null |
| `3xx` (never followed) | `200` | false | `endpoint_redirected` |
| `400`/`401`/`404`/`422` | `200` | false | `endpoint_rejected` |
| `408`/`429` | `200` | false | `endpoint_busy` |
| other `4xx`, any `5xx` | `200` | false | `endpoint_rejected` / `endpoint_error` |
| no answer inside five seconds | `200` | false | `endpoint_timeout` |
| connection refused, DNS failure | `200` | false | `endpoint_unreachable` |

A **platform** condition is an error and never a report about the merchant's server: a signing secret that will not
open, a revoked credential, or an envelope past its ceiling answers `500 INTERNAL_ERROR` and sends nothing. A
`somebody's server said 503` and a `the platform could not sign` must not read the same in a merchant's dashboard.

## The event is the payment's own

There is no `webhook.test` event type and no synthetic body, because a second body shape would teach a store's handler
to accept something production never sends. The event type is derived from the state of a row this service read in
test mode, so a caller cannot ask the platform to announce a refund that never happened — and an unknown field such as
`event_type`, `payment_id` or `signature` is refused rather than ignored. The event id is STEP 205's own derivation,
so a store comparing a simulation with a real delivery sees the same id for the same event.

A `pending` payment has no event at all, and the call says so: `422 { field: "payment.status", rule:
"status_not_deliverable" }` — STEP 205's rule word, for STEP 205's reason.

## Why five seconds

A production delivery may hold a worker slot for ten. A merchant's `POST` cannot hold a request that long, so the
transport is capped at **half** of STEP 205's ceiling (`Math.floor(STORE_WEBHOOK_TIMEOUT_MS / 2)`), and a store that
needs longer than five seconds to answer a webhook is a store whose production deliveries will time out too.

## The chain, written twice on purpose

STEP 205's own entries are still written by the delivery it performs — `api.webhook_delivered` on a `2xx`,
`api.webhook_failed` with `will_retry: false` otherwise — so a simulated delivery leaves the same record a real one
does, and an operator watching FEATURE_LIST §32's failure count sees it. Beside them, `api.sandbox_webhook_simulated`
marks the event as a **simulation**, carrying the event id and type, the verdict, the store's status and the endpoint's
host, and `mode: "test"` — which is how a probe is told apart from a merchant's traffic.

Refusals write `api.sandbox_webhook_refused` with the rule, before anything is sent. Neither entry carries the signing
secret, the presented key, the request body or the endpoint's path.

## What the gate proves (12 sections, 382 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration (128, 99 tables); the delivery is STEP 205's imported functions rather than a second implementation (the service signs nothing, builds no transport, serialises nothing); and 205's transport still refuses redirects, still refuses caching and still compares in constant time |
| 2 | The route: `POST` only, dynamic, awaited params, the pipeline with the **template**, the delivery's own runtime, the credential fenced **before** the body read, the caller's address handed on, no cookie, no CSRF, no idempotency key, nothing printed |
| 3 | The test fence: a live credential is `403` with the sandbox's own rule before any payment read and with nothing sent; the guard passes a test credential silently and records a refusal exactly once when it refuses |
| 4 | The payment read: STEP 204's ten columns, never a star and never a card field, narrowed by id, company, the literal test mode, `invoice_id is.null`, `deleted_at is.null` and `limit=1` |
| 5 | The event: eight states have an event and `pending` is the one that does not; `payment.<status>` for every state; a declined and a refunded payment announce themselves with STEP 205's own ids; `pending` is `422 status_not_deliverable` with nothing sent; and there is no synthetic `webhook.test` type in the event list |
| 6 | The endpoint fence: thirteen refusals (`http:`, loopback, named loopback, metadata, internal host, credentials in the URL, a non-default port, `javascript:`, a backslash, markup, empty, blank, past the ceiling) each `422` naming `endpoint_url` with nothing sent; and a `:443` canonicalised, with the answer naming the host and never the path or the scheme |
| 7 | The delivery: one request, the validated URL, the **five-second** deadline (and that it is derived from 205's ten), the four headers with attempt `1`, a signature that verifies with the merchant's own secret and refuses another, and a body that is **byte for byte** `storeWebhookEnvelopeOf`'s output — STEP 204's ten fields, no company id, no secret. Then the real `fetch` double: one POST, `redirect: "manual"`, `cache: "no-store"`, an `AbortSignal` |
| 8 | The verdict table above, rule by rule, each answering the caller `200`, each carrying the store's own status — and the six reported rules proved to be exactly STEP 205's endpoint rules, in its order |
| 9 | The platform's failures: a box that will not open and a credential STEP 202 would never have authenticated are `500 INTERNAL_ERROR` with nothing sent; a failure that is not the transport's own is classified as a production delivery classifies it, with no status to report |
| 10 | The chain: the simulation entry's action, entity, id, null actor, company, address, event id and type, verdict, status, host, mode and credential — never the secret, the key or the path; STEP 205's delivered and failed entries still written with `mode: "test"` and `will_retry: false`; and a deaf trail that neither fails a delivery nor lets a live credential through |
| 11 | Through the pipeline: `200` with the version header and `no-store`, one body read, three counters, one `api.call` entry under the template; a live key `403` before its body is read while the call is still recorded; and the answer's eight flat fields |
| 12 | The request and the vocabulary: one field accepted; seven refusals with their own rule (`endpoint_missing` four ways, `unknown_field` twice, one of them `signature`); a non-JSON body; a declared and an undeclared oversized body, both `413`; five malformed ids with STEP 204's field and rule and nothing sent; five kinds of "not yours" as one `404`; and every rule, action and path pinned as the constant it is |

### The mutations

Thirty-six, each restored immediately, **36 caught**. They are: the action's segment renamed; the deadline widened to
the worker's; the body ceiling raised to a megabyte; the answer's object renamed; the read selecting a card column; a
timeout made a platform failure; the simulation and not-deliverable actions and rules renamed; the guard letting a
live credential through; the service trusting its caller's fence; each of the read's four fences dropped (mode,
invoice, deleted, limit); every payment announcing a capture; the endpoint not validated; the deadline not shortened;
the observed status neither recorded nor reported; a delivery never reported as delivered; a platform failure
reported as the store's; the simulation entry naming the wrong host, claiming a delivery, or dropping the rule; a
landed simulation not recorded; a refusal naming no entity; the envelope carrying the wrong mode and the epoch's
instant; the answer naming the URL instead of its host; a non-strict request schema; an unbounded declared body; and
the route reading the body before the fence, recording the arriving path, accepting a second verb, or taking the
wrong runtime.

Two misses in the first round are worth recording, because both were **gate** weaknesses: renaming
`endpoint_missing` changed nothing the gate could see, because it compared the refusal against the constant it had
just renamed — every rule is now also pinned to its literal; and a route that took the wrong runtime still imported
the right one, so a `includes` check passed — the check now requires the call site.

## Security

- **Validation** — the credential fenced before the body, the body bounded twice and parsed strictly against one
  field, the id through STEP 204's parser, the endpoint through STEP 205's validator (twice: here and inside the
  delivery), and the event derived from the row rather than accepted from a caller.
- **The test fence** — a live key is refused `403` before any payment is read, and every payment query says
  `mode=eq.test` as a literal, so test and live rows cannot mix even if one of the two fences is removed.
- **The secret** — opened per delivery by STEP 205's own code under `credentialSecretContext(company_id)`, used to
  sign one body, and absent from the request body, the answer and every chain entry.
- **The outbound request** — one POST with `redirect: "manual"` (a merchant's `3xx` cannot walk a signed body to a
  host nobody approved), `cache: "no-store"`, a five-second abort signal, the response body never read, and the
  answer naming the endpoint's host and never its path.
- **The chain** — two entries per simulation, the delivery's own and the simulation's marker, both `mode: "test"`, and
  neither carrying the key, the secret, the body or the URL path.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-sandbox-webhook.ts` | exit 0 — "sandbox webhook gate passed: 382 checks" |
| `npm run verify` | exit 0 — **79 gates**, including the unchanged checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 800 source files, audit 4562 |
| `npm run build` (inside `verify`) | ✓ compiled; the route table lists `ƒ /api/public/v1/payments/[id]/webhook-test` |
| Mutation round | 36 mutations, **36 caught** |

The smoke ran the production build against `.env.example`'s placeholder environment (`npx next start -p 3407
-H 0.0.0.0`, since removed), with no database behind the placeholder URL:

```
POST {id}/webhook-test, no key          → 401 AUTHENTICATION_REQUIRED      (refused at the pipeline)
POST {id}/webhook-test, "Bearer nope"   → 401 AUTHENTICATION_REQUIRED      (malformed, no query)
GET  {id}/webhook-test                  → 405                              (the framework's, one verb)
POST {id}/webhook-test, kd_test_… key   → 502 DEPENDENCY_FAILED, retryable  (no database behind the placeholder)
```

A delivery to a **loopback** endpoint cannot be exercised through the running app, because STEP 205's endpoint fence
refuses private hosts by design - which is the fence this STEP inherits and the gate pins. The delivery's real bytes,
signature, headers and transport options are therefore proven in the gate (including against a real `fetch` double),
and STEP 205's own integration run proved the same transport over a real socket.

## Carried gaps (named rather than hidden)

1. **Still no endpoint column.** The endpoint arrives in this request's body, exactly as it does for STEP 205's
   deliveries. A STEP that owns a merchant-facing settings surface should store it, and then this body field becomes
   optional rather than required.
2. **A simulation is not retried.** It is one attempt, synchronously, with a five-second ceiling: a store whose server
   is down gets a report, not a queue. That is the point of a probe, and STEP 205 is where retries live.
3. **The delivery's own chain entries say `will_retry: false`** even for a rule the queue would have retried, because
   there is no queue behind this call - an operator reading `api.webhook_failed` sees one attempt, correctly.
4. **No UI.** §8's "send a test webhook" button belongs to the credential settings screen the range does not own; this
   STEP is the endpoint such a button would call.
5. **An event is sent for the payment's current state only.** A store cannot ask for "the capture that happened
   before the refund"; the payment's history is STEP 204's `updated_at` and the ledger's, not this surface's.
