# STEP 209 — WooCommerce plugin payment and callback handling

Status: **complete**. Commit `STEP 209: WooCommerce plugin payment and callback handling` on
`arena/ca936761-kd-solution-it`, branched from STEP 208's `0cac943`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **81 gate lines**, this STEP's gate is `lib/api/verify-store-callback.ts` at
**412 checks**, mutation-checked with **57 mutations, 57 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2666`:

> **209. WooCommerce plugin payment and callback handling**

The FEATURE_LIST sentence it completes is section 20's pair:

> A public API exists for online store payments only.
> WooCommerce: the platform has its own plugin. A merchant logs in with credentials in the plugin and the connection
> becomes active automatically.

STEP 208 built the login and the connection row. This STEP is what the connection is **for**: the plugin creates the
payment at checkout, and the platform calls the shop back about it.

## Order, and the gap this STEP sits inside

Implemented immediately after 208 at the owner's instruction. **STEPs 210-230 still have no handoff and no code in this
tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing here
depends on the missing range: it reads STEP 203's payment, STEP 204's status, STEP 205's transport and rules, and
STEP 208's connection.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/store-callback-fields.ts` | new | 159 | The vocabulary: the `{id}/callback` resource, the derived shop address, the envelope and its six keys, the id prefix, the headers, the ten-second ceiling, the rules and the three chain actions |
| `lib/api/store-callbacks.ts` | new | 454 | The service: the connection read that refuses an ambiguous tenant, the derived-and-validated address, the sealed token opened under STEP 208's associated data, the envelope, the one attempt and its verdict, and the chain |
| `lib/api/store-callback-runtime.ts` | new | 27 | The production wiring: STEP 205's transport and the platform's sealer, and nothing of its own |
| `app/api/public/v1/payments/[id]/callback/route.ts` | new | 69 | `POST /api/public/v1/payments/{id}/callback`, through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-store-callback.ts` | new | 1547 | The gate: a PostgREST-shaped fixture over `payments` and `store_connections`, a recording transport, the real transport against a fake `fetch`, and thirteen sections of 412 checks |
| `plugins/woocommerce/kd-payments/includes/class-kd-payment-gateway.php` | new | 252 | The checkout gateway: USD only, the amount from a two-place string, the derived idempotency key, the order on hold |
| `plugins/woocommerce/kd-payments/includes/class-kd-callback.php` | new | 300 | The endpoint: the store token in constant time, a bounded and strictly-shaped body, the platform re-read, the order moved once |
| `plugins/woocommerce/kd-payments/includes/class-kd-api-client.php` | edited | 159 → 224 | `create_payment` and `payment_status`, the `idempotency-key` header, and whether the call was a replay |
| `plugins/woocommerce/kd-payments/kd-payments.php` | edited | 104 → 125 | The two WooCommerce-dependent files loaded **inside** the boot check, and the gateway registered |
| `plugins/woocommerce/kd-payments/readme.txt` | edited | 60 → 88 | The callback's address, its checks, and what a shop does when one is missed |
| `package.json` | edited | +1 script, +1 link | `check:store-callback`, and one link in the `verify` chain after `check:woocommerce` |

Ownership follows `STEP_PLAN_250.md:120-122` — API and Plugin STEPs 200-211 own `app/api/public/`, `lib/api/` and the
plugin source folders. `package.json` is the integrator-owned shared file, touched for one script and one chain link.

**No migration.** The payment is `0033`/`0034`'s row read through STEP 204; the shop is `0035`'s row from STEP 208; the
token is the box STEP 208 sealed, and this STEP merely **opens** it. The next free number stays **129**, and the
migration gate is unchanged at 3778 checks, 128 migrations, 99 tables.

## The two halves, and why the callback cannot be a webhook

STEP 205 already delivers webhooks, and this STEP deliberately does not deliver another one. The difference is the
**secret**:

| | proven by | the shop has it? |
| --- | --- | --- |
| STEP 205 webhook | an HMAC over the body, keyed with the merchant's **credential signing secret** | **No** — section 20 shows it once, on the platform, and never again |
| STEP 209 callback | the **store token** the shop minted on activation | **Yes** — it is the shop's own secret |

So a connection-backed shop is called with its own token as a bearer credential, and the plugin compares it with
`hash_equals` before it reads a byte of the body. `0035` says the same thing in its own words about the column this token
is sealed in: *"the access token the platform will call the store with."*

The address is not stored either, and does not need to be: a WooCommerce callback is the shop's own host plus
WooCommerce's own route, `https://{domain}/?wc-api=kd_payments_callback`, derived from the bare domain `0035` holds and
validated by STEP 205's own URL fence (`requireHttpUrl`, https only, private hosts refused) before a byte leaves. A caller
cannot aim it: this request names a payment and nothing else.

## The payment, from the shop's side

`process_payment` does six things and stops:

1. **Refuses without a key** — the order-pay screen can reach the method without `is_available()` ever being asked.
2. **Reuses an existing payment** — a customer who submits the same order twice gets the same payment, not a second one.
3. **Bounds the amount** — the platform's own floor and ceiling (50 … 10 000 000 minor units).
4. **Reads the total as a two-place string**, not as a float multiplied by a hundred: `19.99` must be exactly `1999`.
5. **Creates the payment** with an idempotency key derived from the order (`kd-wc-<id>-<16 hex of sha256(order_key|amount|USD)>`),
   so a timed-out request that is retried is the same payment on the platform.
6. **Puts the order on hold**, records `_kd_payment_id` and the mode, reduces stock, empties the cart, and sends the
   customer to the order-received page.

**The currency is refused rather than converted.** The public API is USD only, so a shop trading in anything else does
not see the gateway at all (`is_available()`), and a silent conversion — a wrong amount on a real customer's card — is
never an option.

## The callback, from the shop's side

Six checks, in this order, and each one is where it is for a reason:

1. **The store token, in constant time** (`hash_equals`), from `HTTP_AUTHORIZATION` or `REDIRECT_HTTP_AUTHORIZATION`,
   with `Bearer ` stripped. Before the body.
2. **A 64 KB ceiling**, checked before the body is parsed.
3. **The envelope's exact shape** — six keys, compared whole and strictly against
   `created, id, object, payment, store, type`; the object name, the `cbt_…` id, the `payment.…` type, the payment id's
   UUID shape, and a `store.domain` that is a string.
4. **The order, through the meta the gateway wrote** (`_kd_payment_id`), never through anything the body names.
5. **The platform's own answer**, asked server to server with the merchant's key — `GET /api/public/v1/payments/{id}`.
   The body says what changed; the platform says what is true. **An attacker who learned a token could send
   notifications and still not mark an order paid.**
6. **Idempotency by the callback's id** (`_kd_last_callback_id`): a redelivery changes nothing.

Then the status is applied through WooCommerce's own paths: `payment_complete()` for `authorized`/`captured`/`settled`
(and never on an order already paid), `failed` for `failed`/`voided`, `refunded` for `refunded`, and a note for
`pending`/`under_review`/`partially_refunded`.

Two answers a shop gives that the platform reads as instructions: **`503`** when it could not ask the platform (come
back later), and **`200 {handled: false, reason: "order_not_found"}`** when no order matches (stop; there is nothing
here to try again).

## The three refusals a merchant can act on

| The tenant's connections | Answer |
| --- | --- |
| none | `409 { field: "connection", rule: "connection_missing" }` |
| one, `active` | the callback is sent |
| one, `revoked` | `409 connection_revoked` |
| one, `pending`/`error` | `409 connection_not_active` |
| **two or more** | `409 connection_ambiguous` |

The last row is the one worth explaining. `0035` allows a merchant several shops — the unique index is on
`(company, platform, domain)`, not on the company — and STEP 203's payment row names **no store**. So a tenant with two
active connections is refused rather than called at a guess: sending shop A a notification about shop B's payment would
be worse than a refusal a merchant can act on.

## What the gate proves (13 sections, 412 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration (still 128 / 99 tables); `0035`'s own comment naming this column the token the platform calls the store with, and that the token is a sealed column |
| 2 | The vocabulary: the resource under STEP 203's payments, the template route, the concrete path and its encoding, the object, the entity, the id prefix and pattern, the four header names and the bearer prefix, the `wc-api` names, both ceilings, the derived address **pinned as a literal**, every rule and action pinned as a literal, and `payment.<status>` for all nine states |
| 3 | The address cannot be aimed: seven hosts a connection could hold — loopback, `localhost`, a private range, a home network, a metadata service, a host with a port, an IPv6 loopback — all `422 store_endpoint_invalid` with nothing sent |
| 4 | The connection: none, pending, revoked, two shops, a Shopify connection, a soft-deleted one and another tenant's one — each a `409` with its own rule, nothing sent, and one refusal in the chain |
| 5 | The payment is STEP 204's read: a malformed id, another merchant's payment, an invoice payment and a deleted payment are STEP 204's own statuses and rules; a test key reads its own test payment; a live key cannot see it |
| 6 | The token: one box opened, **under the literal associated data** (`kd-aad-v1|store_connection|<company>|woocommerce|shop.example.com`); a box that will not open is `500 connection_token_unavailable` with nothing sent; a box sealed for another shop does not open |
| 7 | The envelope: six keys in the order the platform writes them, the object, the type, unix seconds, an id pinned against an **independently computed** SHA-256, the payment block read from STEP 204, the shop's domain and identifier, and no token, no key, no ciphertext; then the request — the derived URL, the ten-second ceiling, the bearer token, the id and type headers, the content type, the user agent, **no signature header**, and a one-line body |
| 8 | What the shop did: thirteen statuses classified by STEP 205's own function (2xx delivered, 3xx redirected, 4xx rejected, 408/429 busy, 5xx error) — each answered `200` with the shop's status; a timeout and an unreachable host with no status at all; one request and never a retry |
| 9 | The chain: the delivered and failed entries with their action, entity, id, null actor, company, address, callback id, type, mode, credential, shop, host, status and rule — never the token or the key; and a deaf trail that neither fails a delivery nor loses the request |
| 10 | The route: `POST` and no other verb, dynamic, awaited params, the **template** recorded rather than the arriving path, the path's id handed on, the service called, the address passed, no cookie, no CSRF, nothing printed, and **no body read** |
| 11 | Through the pipeline: `200` with the version header and `no-store`, three counters, one `api.call` under the template, and a keyless call `401` before any handler |
| 12 | The transport is STEP 205's: a real `createStoreWebhookTransport` against a fake `fetch` proves one `POST`, `redirect: "manual"`, `cache: "no-store"` and an `AbortSignal`; a `TimeoutError` becomes the transport's own error; and the runtime wires both dependencies and invents none |
| 13 | The plugin, file by file (six PHP files, discovered by name): the direct-access guard, no `eval`/`extract`/`create_function`/`unserialize`/`error_log`/`var_dump`/`print_r`/`$wpdb`/`$_GET`/bare `echo $`, **balanced delimiters**, and then the two halves: the client's three body fields, the idempotency header and its replay flag; the gateway's USD constant, its floor and ceiling, the two-place string total, the derived key, the hold, the stock, the receipt, no card field, the double-submit guard, WooCommerce's own availability rules and the second key guard; the callback's constant-time comparison, its bearer strip, its **check-before-body** order, its 64 KB ceiling before parsing, its **six-key strict comparison pinned whole**, its id shapes, its meta lookup, its dedupe, the platform re-read, the `503`, the `200 handled:false`, `payment_complete`, the already-paid guard, the `failed` status, the recorded callback id, `wp_json_encode`, `status_header`, no robots, and that the body's own status is **never read** |

### The mutations

Fifty-seven, each restored immediately, **57 caught**. They are: the resource renamed; the object renamed; the id prefix
borrowed from STEP 205; the address forgetting WooCommerce's route value, or losing https; the bearer prefix emptied; the
id header borrowed from STEP 205; the deadline at thirty seconds; the body ceiling at ten times its size; every callback
claiming a capture; three rules and one action renamed; two shops called at a guess; a revoked connection activated; a
pending one called; the platform and deleted fences dropped from the connection read; only one connection ever read; the
derived address not validated; the token sealed without the domain, or not sent at all; the instant at the epoch; the id
not naming the status; the body ceiling not checked; the shop's status not reported; a refusal reported as delivered; a
timeout reported as unreachable; every delivery recorded as a success; the chain recording a URL as a host; the answer
naming the wrong type; an unopenable token blamed on the merchant; the route recording the arriving path, accepting
`GET`, or inventing an id; the gateway charging in euros, at a five-cent floor, with a float total, a clock for an
idempotency key, a pending order, no stock reduction, a second payment on a second submit, or WooCommerce's availability
skipped; the callback comparing with `===`, at a megabyte, tolerating a missing key, never asking the platform, applying
twice, answering `200` where `503` belongs, paying without WooCommerce, omitting the status header, or forgetting the
callback id; the client sending an `amount` field, dropping the idempotency header, or hiding a replay; and the gateway
never registered, or loaded before WooCommerce exists.

Two misses in the first round were **gate** weaknesses of the same shape STEP 208 already taught, and both were fixed
with literals: the callback id was compared with `storeCallbackIdOf`, the very function the mutation changed, so it is
now pinned against an SHA-256 the gate computes itself **and** to two behavioural facts (a refund's id differs from a
capture's, and two merchants never share one); and the plugin's six-key envelope check was asserted by its key list
alone, which a weakened comparison still contains, so the comparison is now pinned **whole** — `!==` against
`sorted_keys`, not a subset. A third, the body ceiling, is a branch this gate cannot reach with a real envelope, and is
now pinned as the platform-fault it is, with its rule and its error code.

## Security

- **Authentication** — the merchant's public API key through STEP 202's pipeline, `401` before any handler, counted in
  three buckets and recorded once.
- **Tenant isolation** — the payment is read by STEP 204's own function, narrowed by company and mode; the connection by
  company and platform; another merchant's payment and another merchant's shop both answer the same `404`/`409` a
  nonexistent one does.
- **The shop's token** — opened under the associated data that binds merchant, platform **and domain**, sent only to the
  address derived from that same domain, and never present in the body, the answer or any chain entry.
- **No SSRF** — the address is derived from a stored, validated domain and then passed through STEP 205's fence, which
  refuses private hosts, credentials, ports and any scheme but https.
- **No redirects, no caching, no retry** — STEP 205's transport, unchanged, with a ten-second abort signal and the
  response body never read.
- **The plugin** — capability-free by design (it is a public endpoint), so its whole security is the token comparison,
  the strict envelope, the meta lookup, the platform re-read and the idempotency key; no card data, no secret in a log,
  no SQL of its own, and every printed value through `wp_json_encode`/`esc_html`.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-store-callback.ts` | exit 0 — "store callback gate passed: 412 checks" |
| `npm run verify` | exit 0 — **81 gates**, including the moved checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 810 source files, audit 4632 |
| `npm run build` (inside `verify`) | ✓ compiled; the route table lists `ƒ /api/public/v1/payments/[id]/callback` |
| Mutation round | 57 mutations, **57 caught** |

The smoke ran the production build against `.env.example`'s placeholder environment (`npx next start -p 3409
-H 0.0.0.0`, since removed), with no database behind the placeholder URL:

```
POST {id}/callback, no key                     → 401 AUTHENTICATION_REQUIRED      (refused at the pipeline)
POST {id}/callback, "Bearer nope"              → 401 AUTHENTICATION_REQUIRED      (malformed, no query)
GET  {id}/callback                             → 405                              (the framework's, one verb)
POST {id}/callback, kd_test_… key              → 502 DEPENDENCY_FAILED, retryable  (no database behind the placeholder)
POST not-a-uuid/callback, kd_test_… key        → 502 DEPENDENCY_FAILED, retryable  (authenticated before the id is parsed)
```

Every branch behind that point — the connection states, the derived address, the sealed token, the envelope, the
thirteen classifications and the chain — is proven in the gate against a PostgREST-shaped fixture and a recording
transport, because a real database and a real shop are not available in this environment.

## Carried gaps (named rather than hidden)

1. **The plugin was written, reviewed and never executed.** No PHP interpreter, no WordPress, no WooCommerce here, so no
   `php -l` and no checkout. The gate's delimiter walk is not a parser. The first run of this package on a real store —
   one test-mode order end to end — is the real proof and it has not happened yet.
2. **Nothing calls a callback automatically.** The trigger is the merchant's own `POST …/callback`, because STEP 205's
   queue addresses *stored endpoints* and a connection has a domain instead. A payment that changes state on the
   platform does not, by itself, notify the shop: a store that wants push notifications needs the delivery wired into the
   payment lifecycle, which belongs to whichever STEP owns that service.
3. **A buyer cannot pay an API-created payment in this tree.** `POST /payments` answers an id and a status, not a
   hosted checkout URL; the only buyer-facing payment page that exists is the payment link's (`/p/{token}`), and an API
   payment has no link. So the gateway creates the payment, and the platform half of "the customer actually pays" is a
   **merchant-facing checkout page** nobody has built. It is named, not hidden: it is the largest gap this STEP leaves.
4. **`0035` stores a bare domain, not a path.** A WordPress installed in a subdirectory (`https://host/blog/`) answers
   its `wc-api` route at `/blog/?wc-api=…`, and the derived address would miss it. The domain column's own shape forbids
   the fix, so a subdirectory store needs a path column or a redirect at the site root.
5. **One connection per tenant, for now.** A merchant with two shops is refused (`connection_ambiguous`) because
   STEP 203's payment row names no store; a `store_connection_id` on the payment would make the call unambiguous, and it
   is a migration this STEP does not own.
6. **No UI.** The plugin's admin screen (STEP 208) shows the connection; it does not list payments or their callbacks.
   The platform's merchant dashboard has no "connections" screen either, so a callback's outcome is visible only in the
   chain and in the shop's own order notes.
7. **The webhook and the callback are two different notifications.** A merchant who configured an endpoint for STEP 205
   and also installed the plugin receives both, about the same payment, with different proofs and different bodies. A
   later STEP may want to suppress one when the other is configured; today the plugin's dedupe makes the second
   harmless, and the plan says nothing either way.

---

## Audit addendum (2026-11-07) — the sweep over STEPs 181 to 209

The instruction after this STEP was to check every STEP in the 181 to 209 range for a defect or a gap.
Full record: **`docs/AUDIT_181_209.md`**. What changed for *this* STEP:

1. **A test a merchant can press** — the gap above said a merchant could not see the path work before a real customer
   paid. The screen now has **Send a test callback** (`handle_test_callback()`, its own nonce and capability check),
   which asks `KD_Connection::test_callback()` to find the newest payment this shop created through the gateway's own
   meta and asks `KD_Api_Client::request_callback()` to have the platform call this shop about it. It reports the
   platform's `delivered` and `rule`, and it **never marks an order paid**: only the endpoint may, and only after asking
   the platform. Nine gate checks and four mutations cover it.
2. **Gap 4 is now refused instead of mis-connected** — `install_path()` reads the path from `home_url()`, and
   `connect()` refuses a shop installed in a subdirectory before it sends the handshake, because the derived address
   `https://{domain}/?wc-api=…` cannot reach `/blog/?wc-api=…`. A path column is still the real fix and still a
   migration; until then the failure is stated, not silent.
3. **The plugin's order lookup could pay the wrong customer** — `order_of()` used `meta_query` alone, which WooCommerce's
   legacy post store silently ignores, so the endpoint would have moved the newest order on a callback naming a different
   payment. It now asks both ways and verifies every candidate with `get_meta()`. This was the worst defect in the range
   and it failed silently.
4. **Ambiguity was permanent** — `connectionOf()` counted every row, and `0035` never deletes a revoked one, so a merchant
   who moved shops was refused `409 connection_ambiguous` for good. It counts active rows now, and answers
   `connection_missing`, `connection_revoked` or `connection_not_active` in the order a merchant can act on.
5. **Carried gap 2 is unchanged and now guarded** — nothing in this tree moves a store payment's state, so nothing can
   schedule a callback (or a STEP 205 webhook). The seam a later STEP calls is pinned by `verify-store-webhooks`, so the
   job cannot quietly become unreachable and no route can register it for itself.
