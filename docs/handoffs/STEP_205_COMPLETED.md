# STEP 205 — Store webhook delivery to merchant store with retries

Status: **complete**. Commit `STEP 205: Store webhook delivery to merchant store with retries` (`9c561f1`) on
`arena/ca936761-kd-solution-it`, branched from STEP 204's `4af31bb`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **77 gate lines**, this STEP's gate is `lib/api/verify-store-webhooks.ts` at
**261 checks**, mutation-checked with **36 mutations, 36 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2618`:

> **205. Store webhook delivery to merchant store with retries**

FEATURE_LIST §27 lists webhook processing among the platform's background jobs, §28 makes the request path
*"validate, write minimal rows, enqueue"* and says the work itself belongs to a job, and §29 makes a retry the
queue's decision rather than a handler's. §8's test/live separation and §18's hosted-fields rule carry over
unchanged: the mode comes from the credential, and no card field is read, selected, stored or serialized.

STEP 204 gave a store a `GET` to poll. Polling is the fallback, not the contract: a checkout that ships when a
payment is captured should be **told**, once, with a body it can verify — and told again if its own server was
restarting. That "again" is why this STEP is a job and not a `fetch` inside somebody's request.

There is **no UI in this STEP**, for the same reason as 203 and 204: §20's screens belong to the credential STEP,
and what a store integrates with is an endpoint and a signature. The desktop and mobile check has nothing to
render; the deliverable is a delivery, and the real-socket run below is what "exercised" means here.

## Order, and the gap this STEP sits inside

Implemented immediately after 204 at the owner's instruction. **STEPs 206-230 still have no handoff and no code in
this tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing
in 205 depends on the missing range: it depends on 202's credential pipeline, 203/204's payment vocabulary and the
`lib/jobs` foundation.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/store-webhook-fields.ts` | new | 259 | The vocabulary: the job name, the eight deliverable event names, the envelope shape, the four delivery headers, the twelve rules and `isFinalWebhookRule`, the status map, the attempt ceiling and the three time/size ceilings |
| `lib/api/store-webhooks.ts` | new | 642 | The service: endpoint validation, event id, envelope, serializer, signer, the store's own verifier, the transport, `deliverStoreWebhook`, the job definition, `registerStoreWebhookJob` and `scheduleStorePaymentWebhook` |
| `lib/api/store-webhook-runtime.ts` | new | 57 | The composition root the route/job side calls: `getStoreWebhookRuntime()`, `getStoreWebhookScheduleRuntime()`, `registerStoreWebhookJobOnPlatform()` |
| `lib/api/verify-store-webhooks.ts` | new | 1295 | The gate: a PostgREST-shaped credential fixture, a recording transport, eleven sections and 261 checks |
| `package.json` | edited | +1 script, +1 link | `check:store-webhooks`, and one link in the `verify` chain after `check:store-payment-status` |

Ownership follows `STEP_PLAN_250.md:120` — API and Plugin STEPs 200-211 own `app/api/public/` and `lib/api/`.
`package.json` is the integrator-owned shared file, touched for one script and one chain link and nothing else.

**No migration.** No column or table is added: the next free number stays **129**, and the migration gate is
unchanged at 3778 checks, 128 migrations, 99 tables. What that costs is named in the first carried gap below.

## How a delivery happens, in one paragraph

Payment code that moves a payment to a new state calls `scheduleStorePaymentWebhook({ companyId, credentialId,
mode, endpointUrl, payment })`. The event type is *derived* from the payment's status (`captured` → `payment.captured`)
and `pending` is refused outright, because a pending payment has not moved. The endpoint is validated
(`https`, public host, no credentials in the URL, no non-443 port, length ceiling), the event id is hashed from
`(company, payment, event)`, an audit entry `api.store_webhook.scheduled` is written, and **one** job is enqueued
under the idempotency key `evt_…` — so a payment transition replayed twice still sends one webhook. The worker
later picks the job up: it re-validates the endpoint from the payload, reads the credential row, opens the signing
secret from its AES-256-GCM box under `credentialSecretContext(company_id)`, rebuilds the same envelope from the
payment carried in the payload, signs it, POSTs it once, and classifies whatever came back.

## The endpoint gap, and why this STEP does not close it

There is **no column anywhere in this tree that says where a store wants its webhooks delivered**. `0032`'s
`webhook_events` table is inbound provider traffic, `0034` holds only the signing secret and its tail, and no STEP
in 200-211 owns adding a store endpoint column or a store-webhook table — this STEP's block grants no migration
exception, and inventing `0129_*` would be writing in another STEP's territory.

So the endpoint is **supplied by the caller**: validated at schedule time, carried inside the job payload, and
**re-validated at attempt time**, because a payload is data that has crossed a boundary and a retry must not be
the place an unvalidated URL finally reaches a socket. The same validation runs in both places, so a future STEP
that adds the column only has to read it and pass it in. Until then, an operator-visible consequence is real: no
production caller exists yet, which the "wiring seam" gap below states plainly.

## The signature contract, stated for the store's side

One header, one scheme, and the verifier is shipped as code rather than as a paragraph:

```
x-kd-signature: t=1793620800,v1=<lower case hex HMAC-SHA256 of "1793620800.<exact body bytes>">
```

The key is the credential's signing secret. The timestamp is inside the signed string, so a captured delivery
cannot be re-signed with a fresh-looking header, and the store compares `t` against its own tolerance window
(`verifyStoreWebhookSignature` defaults to 300 seconds). The HMAC is compared with `timingSafeEqual` after a
length check. Four more headers travel with it: `x-kd-event-id`, `x-kd-event-type`, `x-kd-delivery-attempt` and a
`user-agent` of `kd-solution-it-webhooks/1`. `verifyStoreWebhookSignature` is the store's half, exported from the
same module, so a merchant can read one implementation instead of three documents.

## Why the retries belong to the queue, not to this module

The job is defined with `maxAttempts: 5` and **the queue decides when the next attempt happens** — `job_queue`'s
`attempt / max_attempts / available_at / idempotency_key` columns and the foundation's `retryDelayMs`. This module
never sleeps, never loops and never writes its own backoff:

- a **transient** rule throws `AppError("DEPENDENCY_FAILED", { cause: { rule } })` **even on the last attempt**, so
  the job ends `failed` and an operator counting §32's failures sees a webhook the merchant never received —
  rather than a job that "completed" while the store got nothing;
- a **final** rule returns an outcome and never throws: the store answered, its answer was a decision, and asking
  it a second time is noise. A **non-2xx final** is *not* an exception for the same reason.

That split is the one design decision a future reader is most likely to want changed, so it is stated here with
its consequence: a store whose server is down for longer than five attempts' worth of backoff is not retried
again, and the failure is visible in the chain and in the queue rather than in a log line.

## The classification, exactly

| Answer | Rule | Kind |
| --- | --- | --- |
| 2xx | `delivered` | final, recorded as delivered |
| 3xx | `endpoint_redirected` | final — a redirect is never followed (`redirect: "manual"`) |
| 400, 401, 403, 404, 422 | `endpoint_rejected` | final |
| 408, 425, 429 | `endpoint_busy` | transient |
| other 4xx | `endpoint_rejected` | final |
| 5xx | `endpoint_error` | transient |
| connection refused / DNS | `endpoint_unreachable` | transient |
| the timeout elapsed | `endpoint_timeout` | transient |
| the credential is gone, inactive or in the other mode | `credential_unavailable`, `credential_revoked`, `credential_mode_mismatch` | final |
| the box does not open | `credential_unavailable` | final |
| the endpoint no longer validates | `endpoint_invalid` | final |
| the payload's status disagrees with its own event type | `status_not_deliverable` | final |

## What the gate proves (11 sections, 261 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration was added (128, 99 tables), and the two tables that decided the design still say so: `0034`'s comment *"must be used later to sign an outbound delivery"*, and `0002`'s attempt / backoff / idempotency columns |
| 2 | Thirteen endpoints refused (`http:`, loopback, `.local`, metadata address, `user:pass@`, port 8443, `javascript:`, backslash, `<>`, empty, over the length ceiling, non-string, missing) and two canonicalised (`:443` dropped, upper-case host lowered) — and a refused endpoint costs zero rows and zero network |
| 3 | Eight deliverable event names, `pending` refused, the job name and every rule a machine word |
| 4 | The event id is stable per `(company, payment, state)`, differs per state, per payment and per tenant, and matches the chain's `evt_` shape |
| 5 | The envelope: key order `id, object, type, created, data`, ten payment scalars, no company id, no card field, no secret anywhere in the bytes; the byte ceiling is sixteen kilobytes and a one-megabyte body is refused |
| 6 | The signature: `t=<seconds>,v1=<64 hex>` verifies; a changed body, a replayed header, another secret, a malformed header, a truncated one, a wrong version and an out-of-window timestamp are all refused |
| 7 | The transport: exactly one POST, `redirect: "manual"`, `cache: "no-store"`, an `AbortSignal` with the ten-second ceiling, and the response body is never read; a timeout and an unreachable host are distinguished |
| 8 | The status map above, rule by rule, including which side of the transient line each one sits on |
| 9 | The final refusals that never touch the network: a deleted credential, an inactive one, a mode mismatch, a box that will not unpack, a box sealed under **another tenant's AAD**, an endpoint that stopped validating, and an event type that disagrees with the payload's status — each with zero sends |
| 10 | The retries, through the **real** `JobRegistry`, `JobQueue` and `JobWorker`: 500 → `retrying` → next attempt at exactly `retryDelayMs(1)` → 200 → `completed`, with two **byte-identical** bodies, two fresh signatures, and attempt headers `1` then `2`; an always-500 endpoint exhausts five attempts and ends `failed`; a 404 completes after one; a duplicate schedule dedupes to one job |
| 11 | The sources: the module prints nothing, reads no environment variable directly, imports the AAD helper rather than building a context string, never splices a body into a query, and the runtime's three exports are the only composition seam |

### The mutations

Thirty-six, each restored immediately, **36 caught**. They are: `pending` made deliverable; the event name
unprefixed; a redirect made transient; a busy answer made final; a 5xx made a client error; a revoked credential
made transient; the signature header renamed; the attempt ceiling set to one; the body ceiling set to a megabyte;
the timeout set to a minute; the signature version changed; a redirect followed; the endpoint not re-validated at
attempt time; the endpoint never validated at schedule time; the body unbounded; the signature not covering the
timestamp (both halves); the verifier's window removed; the verifier's comparison made non-constant-time; the event
id ignoring the state; the event id ignoring the tenant; a delivered event recorded as scheduled; a failed attempt
recorded as scheduled; the chain recording the endpoint's path; the chain recording the body; a transient failure
completing the job; a final failure retrying for ever; the last attempt claiming another would follow; the
credential's status unchecked; the credential's mode unchecked; a failed secret open made retryable; the envelope's
instant moving with the attempt; the attempt header carrying the ceiling; a duplicate schedule writing a second
entry; `pending` scheduled; and the runtime sealing the AAD from the box instead of the tenant.

Three misses in the first round are worth recording, because each one was a **gate** weakness rather than a code
defect, and each is now closed: the two ceilings were only exercised through their own constants (so widening a
constant widened the test) and are now pinned to their literals and probed with a literal megabyte; the chain's
"no path, no body" claim was asserted on the *scheduled* entry only and now checks each attempt entry; and a box
sealed under another tenant's context was untested. One mutation was dropped rather than chased: the idempotency
key originally read `${companyId}:${eventId}`, but the event id already hashes the tenant, so the prefix was
redundant — the key is now `eventId` and the code says why.

## Security

- **Validation** — the endpoint is validated twice, with the same function, both times before a socket exists; the
  event type is derived from the payment rather than accepted from a caller; the payment id, company and credential
  are carried in the payload and re-checked against the credential row at attempt time.
- **RLS** — nothing here issues a query of its own beyond one credential read through the caller's REST client,
  which carries the tenant filter (`id + company_id`, `deleted_at is.null`, `limit=1`). The gate asserts the filter's
  four conditions; the table's policies are unchanged.
- **The secret** — opened per attempt, used to sign, and dropped: it is absent from the payload, the envelope, the
  headers, every chain entry and every error message. The gate asserts its absence from all five.
- **Audit** — `api.store_webhook.scheduled` once per event, `api.store_webhook.delivered` and
  `api.store_webhook.failed` once per attempt, each naming `event_id`, `event_type`, `mode`, `attempt`, `rule`,
  `status_code`, `will_retry` and `endpoint_host` — and never the secret or the endpoint's path, which a merchant
  may have made unguessable. Writing to the chain is best effort: a deaf trail neither allows nor fails a delivery.
- **The outbound request** — one POST, redirects never followed (so a 302 cannot walk a signed body to a host the
  merchant did not configure), `cache: "no-store"`, a ten-second abort signal, the body never read back, and a
  sixteen-kilobyte ceiling so a store's own storage cannot be inflated through its payment fields.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint lib/api` | exit 0 |
| `node lib/api/verify-store-webhooks.ts` | exit 0 — "store webhook gate passed: 261 checks" |
| `npm run verify` | exit 0 — **77 gates**, including the unchanged checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 792 source files, audit 4506 |
| `npm run build` (inside `verify`) | ✓ compiled successfully; no route is added or changed by this STEP |
| Mutation round | 36 mutations, **36 caught** |
| Real-socket run | see below |

The real-socket run is a script kept out of the tree (`/tmp/integration205.mjs`) that starts an HTTP server on a
loopback port and drives **the production transport**, the production signer and the production verifier over a
real socket. It cannot drive `deliverStoreWebhook` itself, because that path validates its endpoint and a loopback
host is refused by design — which is exactly the fence section 2 pins, and the reason the gate's service-level
tests use a recording transport instead of a listener:

```
delivered 200 · redirect 302 and NOT followed (0 requests reached /hop) · error 500 reported, not thrown
silent endpoint → reason "timeout"
received: POST, content-type application/json, user-agent kd-solution-it-webhooks/1,
          x-kd-event-id evt_4f930e15423c38a93ada4e26ff81e9b3, x-kd-event-type payment.captured,
          x-kd-delivery-attempt 1, body 407 bytes
signature verified with the tenant's secret · refused with another secret · body byte-identical
envelope: evt_… event payment.captured id|object|type|created|data
payment keys: amount_minor,created_at,currency,failure_code,id,mode,object,payment_method,refunded_minor,status,updated_at
retry shape: same bytes, different signature at a later instant
```

## Carried gaps (named rather than hidden)

1. **No endpoint column exists.** The endpoint is the caller's to supply. A STEP that owns a merchant-facing
   settings surface or a store-webhook table should add it, and should then pass `readStoreWebhookEndpoint(...)`
   into `scheduleStorePaymentWebhook` — the validation, the retry and the signature need no change.
2. **Nothing calls it yet.** `registerStoreWebhookJobOnPlatform()` is the seam, and `lib/jobs/runtime.ts`'s own
   comment says the deployment STEP that owns background work decides whether the worker ever starts — so no boot
   file registers this job, and no payment transition schedules one. Both are later STEPs' work, not a defect.
3. **The queue is in-memory.** `lib/jobs/queue.ts` documents that a durable queue arrives with the deployment STEP;
   until then a delivery pending at restart is lost, and the chain's `scheduled` entry is the only record of it.
4. **No endpoint is stored, so no delivery is deduplicated across processes** — the idempotency key protects one
   queue instance. A durable queue makes the key durable with it.
5. **`423` and `409` are treated as final** (the store's own decision), while `425` is transient; a store that uses
   `409` to mean "try later" will not be retried. The rule table is in `storeWebhookRuleForStatus` and is a
   one-line change if a merchant asks.
