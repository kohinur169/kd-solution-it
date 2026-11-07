# STEP 211 — Shopify app payment and callback handling

Status: **complete**. Commit `STEP 211: Shopify app payment and callback handling` on
`arena/65533bbe-kd-solution-it`, on top of STEP 210's `a84146f`. Typecheck, lint and the production build are clean,
`npm run verify` is exit 0 over **83 gate lines**, this STEP's gate is `lib/api/verify-shopify-payment.ts` at
**198 checks**, mutation-checked with **31 mutations, 31 caught**. The app's payment flow and its callback are **run**
over a real socket by that gate, on every verify.

## STEP

From `docs/final/STEP_PLAN_250.md:2690`:

> **211. Shopify app payment and callback handling**

The FEATURE_LIST sentence it serves is section 20's Shopify pair (`:213-219`):

> A public API exists for online store payments only.
> Shopify: the platform has its own Shopify app with approval. A merchant installs the app and logs in with credentials,
> and the connection becomes active and fully functional automatically.

STEP 210 built the install and the connection row. This STEP is what the connection is **for**: the app creates the
payment for a Shopify order, and the platform calls the shop back about it.

## Order, and the gap this STEP sits inside

Implemented immediately after 210 at the owner's instruction. **STEPs 212-230 still have no handoff and no code in this
tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing here
depends on the missing range: it reads STEP 203's payment, STEP 204's status, STEP 205's transport and rules,
STEP 209's callback and STEP 210's connection.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/store-callback-fields.ts` | edited | 160 → 182 | The App Proxy prefix and path, and an address that is a function of **platform and domain** rather than of the domain alone |
| `lib/api/store-callbacks.ts` | edited | 463 → 472 | The connection read now asks for both platforms, the address comes from the row's own platform, and the token is opened under it |
| `lib/api/verify-shopify-payment.ts` | new | 1134 | The gate: a PostgREST-shaped fixture over `payments` and `store_connections`, six sections of platform and contract checks, and the app driven over a real socket |
| `lib/api/verify-store-callback.ts` | edited | 1908 → 1920 | STEP 209's gate, moved with the service: a Shopify connection is now called rather than refused, and the address is asserted for both platforms |
| `lib/api/verify-shopify-connection.ts` | edited | 2273 | STEP 210's gate, whose inventory now names nine modules and whose password pin counts an equality rather than two |
| `plugins/shopify/kd-payments-app/src/payments.mjs` | new | 235 | The money and the order: an amount read from a decimal string, an order reference in both of its forms, and the idempotency key a retry reuses |
| `plugins/shopify/kd-payments-app/src/callback.mjs` | new | 337 | The platform's callback: Shopify's proxy signature, the ceiling, the six-key envelope, the shop match, the dedupe and the bounded record |
| `plugins/shopify/kd-payments-app/src/platform.mjs` | edited | 162 → 199 | `createPayment` and `readPayment`, and an `idempotency-key` header on a call |
| `plugins/shopify/kd-payments-app/src/server.mjs` | edited | 541 → 665 | The callback route, the payment form's two handlers, and a payment refusal answered on a page a merchant can use |
| `plugins/shopify/kd-payments-app/src/screen.mjs` | edited | 234 → 321 | The payment form, the payments this session created, and the callbacks that have arrived |
| `plugins/shopify/kd-payments-app/src/copy.mjs` | edited | 142 → 187 | Fourteen new sentences, including the two panels' and the four notices' |
| `plugins/shopify/kd-payments-app/readme.txt` | edited | 95 → 134 | The payment flow, the App Proxy registration, and what the app deliberately does not do |
| `package.json` | edited | +1 script, +1 link | `check:shopify-payment`, and one link in the `verify` chain after `check:shopify` |

Ownership follows `STEP_PLAN_250.md:120-121` — API and Plugin STEPs 200-211 own `app/api/public/`, `lib/api/` and the
plugin source folders. `package.json` is the integrator-owned shared file, touched for one script and one chain link, as
STEPs 208, 209 and 210 did.

**No migration.** The payment is `0033`/`0034`'s row read through STEP 204, the shop is `0035`'s row, and the callback is
STEP 209's mechanism addressed by a second platform. The next free number stays **129**, and the migration gate is
unchanged at **3778 checks, 128 migrations, 99 tables**. No `app/api/` route was added either: the platform's callback
route (`POST /api/public/v1/payments/{id}/callback`) and the public payment API are already there, and what this STEP
changes is **where a Shopify connection is called** and **what answers it**.

## The two halves, and why Shopify's callback is not WooCommerce's

| | reached how | what proves the caller |
| --- | --- | --- |
| WooCommerce (STEP 209) | **directly**, at `https://{domain}/?wc-api=kd_payments_callback` | the **store token** the shop minted, sealed by the platform in `0035` |
| Shopify (this STEP) | **through Shopify**, at `https://{shop}/apps/kd-payments/callbacks/payment` | **Shopify's app-proxy signature** over the forwarded query, keyed with the app's own client secret |

Two consequences, and both are design decisions rather than accidents:

1. **A Shopify app is reached at the shop's own permanent host without storing an app URL.** Shopify's App Proxy
   forwards `/apps/kd-payments/*` on a shop to the app, so the address is derivable from `0035`'s domain exactly as
   `?wc-api=` is - and STEP 209's carried gap about a bare domain having no path does not bite, because the path is the
   app's own and is the same for every shop.
2. **The proof is signed by Shopify, not minted by the shop.** The platform's request carries the store token as well
   (the service is one service), but the app cannot compare it - it never saw it, because the platform minted it - so the
   app verifies what it *can*: the proxy signature, computed from a secret the platform never sees. The gate proves the
   two message shapes are different functions on purpose, so one can never be verified by the other's rules.

## One defect found in STEP 209's service, and fixed here

`store-callbacks.ts` opened every sealed token under `STORE_CONNECTION_PLATFORM` - the constant `"woocommerce"` - and
filtered the connection read to that platform in SQL. STEP 210 seals a Shopify shop's token under `shopify`
(`storeConnectionSecretContext({platform: "shopify"})`), so a Shopify row read by this service would have been refused
`connection_token_unavailable`, reported as a **platform fault** for a row that is perfectly healthy, and the read would
not even have found the row. Both are now a property of the row: the read names both platforms in one query and the
associated data is `connection.platform`. The gate proves it twice - a Shopify token opens, and a box deliberately sealed
under `woocommerce` for a `shopify` row does not.

## The payment, from the app's side

`POST /payments` asks for four values: the order, the amount, the shop (hidden, from the session) and the merchant's key.
Then:

1. **The amount is read as a string.** `19.99` is `19 * 100 + 99`, exactly; `1.5` is `150`; `0.5` is `50`. Three decimal
   places are refused rather than rounded, and the platform's own floor and ceiling (50 … 10 000 000 minor units) are
   mirrored so a bad amount never leaves the app.
2. **The order is read in both of its forms.** `1001` becomes `gid://shopify/Order/1001`, and a global id is read back to
   the number a merchant recognises. Nothing else is an order - not a name, not a path, not an empty field.
3. **The key is derived from the order, not the clock**: `kd-shopify-<32 hex of sha256(shop|order|amount|USD)>`. The same
   order at the same amount replays the same payment instead of charging twice; the same order at a *corrected* amount is
   a different payment, because a merchant who corrects a total is asking for the corrected total.
4. **The request is the platform's three fields** - `amount_minor`, `currency`, `payment_method` - with the key in the
   `idempotency-key` header, `redirect: "error"`, a ten second abort and a bounded answer.
5. **The answer is reduced to five fields** before it reaches a page, and a payment id is shape-checked, because a screen
   that says "created" about a payment with no id would be lying.
6. **The session keeps the last five payments**, deduplicated by the platform's id, so a replayed create is one row and a
   refresh reads it once. `POST /payments/refresh` asks the platform about each of them and shows the fresh status.

## The callback, from the app's side

`POST /callbacks/payment`, behind the proxy prefix, in this order:

1. **Shopify signed this proxy request** - `signature` over the query's parameters sorted by name and joined with `&`,
   compared with `timingSafeEqual` through the same helper the install HMAC uses, with `timestamp` bounded on both sides
   (five minutes old at most, sixty seconds of future tolerance).
2. **A 16 KB ceiling**, checked against the declared length and then against what actually arrives.
3. **The envelope's six keys, compared whole** - `created,id,object,payment,store,type` - then the object name, the
   `cbt_` id, `payment.<status>` against the platform's nine states, the payment's UUID, its integer amount, and the
   status inside `payment` agreeing with the type.
4. **The shop matches** - the body's `store.domain` must be the `shop` Shopify forwarded it for, so a callback for one
   shop cannot be replayed at another.
5. **This callback is new** - the id is stable per `(company, payment, status)` on the platform, so a redelivery is a
   `200` with `duplicate: true` and changes nothing.
6. **It is recorded, and nothing is applied** - `applied` is always `false`, in the module, in the answer and on the page:
   moving a Shopify order needs an offline Admin API token, and this app holds no Shopify token once the platform has one.

The two answers a caller can branch on: `401` for anything that is not Shopify's signature (nothing is read first), and
`400 { rule }` for a body that is not the platform's envelope. `405` for a verb that is not `POST`.

## What the gate proves (198 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration: 128 forward files and no down file counted twice, no Shopify or callback migration among them, `0035` still saying the sealed column is the token the platform calls the store with, both platforms named there, and the tree still creating 99 tables |
| 2 | The address: the proxy prefix and path pinned as literals, a Shopify shop called at `https://kd-shop.myshopify.com/apps/kd-payments/callbacks/payment`, a WooCommerce shop still called where STEP 209 put it, both https, neither borrowing the other's route; the service reading `platform=in.(shopify,woocommerce)` in one query, taking the address from the row's platform, opening the token under the row's platform, and **not** using STEP 209's constant |
| 3 | The delivery, both ways: a Shopify row delivered once at the App Proxy path with the sealed token as a bearer header and the associated data naming `shopify`; the id recomputed by the gate's own SHA-256; the six envelope keys in order; the store block naming the shop; no token in body, answer or chain; a WooCommerce row still delivered at `?wc-api=`; a Shopify row whose box was sealed under `woocommerce` refused `connection_token_unavailable` with nothing sent; two active shops across two platforms refused `connection_ambiguous`; a revoked Shopify shop; another merchant's Shopify shop; a refund getting its own type and its own id; a shop answering `503` reported as an outcome |
| 4 | The app's nine modules, and no tenth - each with its path comment, no `console`, no `process.env`, no string evaluation, no placeholder - then the payment's vocabulary (the resource spelled once and imported by the client, the key prefix, a derived key satisfying the platform's pattern, no `Math.round` and no `parseFloat`, the mirrored bounds, five payments a session, the `idempotency-key` header, the three-field body), the amount and order parsers proved by value, and the callback's (path, ceiling, five-minute window, the nine states equal to the platform's, the six keys sorted, the comparator pinned, the message's sorted `key=value` join, no bearer token, `applied: false`) |
| 5 | The contract both ways: the platform's `StoreCallbackEnvelope` type and the app's key list naming the same six fields, the id shape one pattern held by both, and the proxy path equal to `STORE_CALLBACK_SHOPIFY_PATH` |
| 6 | The app over a socket: install, the callback's session rotation, the credential login, then a payment created with the derived key, the three-field body and `1999` minor units; a replay carrying the first attempt's key; three decimals and a path-shaped order refused `400` with nothing sent; a refresh reading every payment once and showing the platform's fresh status; the platform's callback accepted through a signature the gate computes itself, then a duplicate, a forged signature, a stale timestamp, an unsigned request, a body for another shop, a seventh key, another object's envelope, a status that disagrees with the type and a 20 KB body each refused with its own answer; and the page listing the callback, never the token, and never another shop's callback |

### The mutations

Thirty-one, each restored immediately, **31 caught**: the Shopify address borrowed from WooCommerce, losing https, its
prefix shortened or its path moved; the connection read narrowed back to one platform; the token opened under
`woocommerce`; the address taken from a constant rather than the row; the key losing its origin, or derived from a clock;
the amount read as a float, a half read as five, the floor dropped to a penny; a session keeping fifty payments, or a
replayed payment listed twice; the callback accepting every verb, never checking the signature, joining its message
wrongly, sorting it backwards, accepting a stale one, at a megabyte, a seventh key, or for another shop; a redelivery
recorded twice; the app claiming to have moved an order; a payment state forgotten; the callback verified with the wrong
secret; outcomes hidden; the amount taken as a number and multiplied twice; a field losing its label; and a catalog title
changed.

Two were **gate weaknesses** in the first round and are worth naming, because both were the same shape STEP 210 had
already taught: the proxy signature was verified by the app's own function and the gate built its query with that same
function, so reversing the sort still verified - the gate now computes the message and the HMAC **itself** and compares;
and a catalog title was not pinned anywhere, only *some* titles were, so the panel's own sentence is now pinned where it
lives. A third miss was a needle that no longer matched the file (a control I had intended to be a no-op), removed.

## Security

- **Authentication, platform side** — the merchant's public API key through STEP 202's pipeline, `401` before any
  handler; the callback route and the payment API are STEP 209's and STEP 203's own.
- **The address cannot be aimed** — derived from `0035`'s domain and platform, then passed through STEP 205's URL fence
  (https only, private hosts and ports refused) before a byte leaves. A caller still names a payment and nothing else.
- **The token opens under its own row** — merchant, platform **and** domain, which is what makes a Shopify row's box a
  box and not a platform fault. Fixed here, and proved by a box deliberately sealed under the other platform.
- **The app's boundary** — Shopify's proxy signature in constant time with a bounded timestamp before a byte of the body
  is read; a 16 KB ceiling; six keys compared whole; the body's shop tied to the shop Shopify forwarded it for; dedupe
  by the platform's id; `no-store`, `default-src 'none'`, `frame-ancestors 'none'`, `DENY`, no referrer on every answer.
- **Nothing is stored** — no merchant key, no Shopify token after the platform has it, no callback body, no outcome
  beyond a bounded list of ids and statuses per shop. A process restart loses them, which is the intended cost.
- **No order is moved** — the app records what the platform said and says so on the page; it never writes to Shopify.
  That is a deliberate gap, not an omission, and it is the first thing a later STEP has to decide about.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-shopify-payment.ts` | exit 0 — "shopify payment gate passed: 198 checks" |
| `node lib/api/verify-store-callback.ts` | exit 0 — **481 checks** (STEP 209's, moved with the service) |
| `node lib/api/verify-shopify-connection.ts` | exit 0 — **565 checks** (STEP 210's, whose inventory now names nine modules) |
| `npm run verify` | exit 0 — **83 gates**, including migrations 3778 / 128 / 99, i18n 3228 / 343, structure 816 source files, audit 4674 |
| `npm run build` (inside `verify`) | ✓ compiled; no route changed, because none was added |
| Mutation round | 31 mutations, **31 caught** |

No production-build HTTP smoke this time, and the reason is worth stating: this STEP adds **no** Next.js route. The
platform's callback route, the payment route and the status route are STEPs 203/204/209's, already smoked there; what
changed is which address a Shopify row is called at and which app answers. That app is not a Next.js process - it is the
standalone Node app, and the gate runs it over a real socket end to end.

## Provider documentation

Fetched by this session: **none**, because `shopify.dev` is not reachable from this environment (STEP 210 recorded the
same limit). What follows is from STEP 210's recorded review and this session's reasoning, and it is marked for whoever
owns `docs/final/PROVIDER_DOCS.md` - which this STEP does **not** edit, because it belongs to the adapter STEPs 147-169.

- The App Proxy signing algorithm (sorted `key=value` pairs joined by `&`, HMAC-SHA256 hex with the app's client secret,
  compared against the `signature` parameter, `timestamp` freshness) is implemented from Shopify's documented behaviour
  and has **never been exercised against a live proxy**. Two details are unverified and named here: whether already
  URL-encoded values are signed encoded or decoded, and whether `logged_in_customer_id` is always present.
- The Admin GraphQL API and its current stable version are **not** used by this STEP (see the first carried gap), so the
  version pin STEP 210's handoff asked for is still owed by the STEP that writes the first Admin API call.
- The App Proxy prefix `/apps/kd-payments` is registered in the Shopify Partner dashboard, with the app's origin as its
  target and the path forwarded unchanged. That is a release action, like the app's own registration.

## Carried gaps (named rather than hidden)

1. **Nothing marks a Shopify order paid.** A payment exists on the platform and is listed in the app; the order is moved
   in Shopify's admin. Calling `orderMarkAsPaid` (or any Admin API mutation) needs an **offline** access token stored
   somewhere durable, and this app's whole design is that it stores none. That is a design decision to revisit, not a
   call to add: the two ways out are storing an encrypted offline token in the app, or a Shopify Payments app that
   Shopify itself calls. Neither is in this tree.
2. **The app-proxy signature has never seen a live proxy.** The algorithm is implemented and proved against a signature
   the gate computes itself, which proves the *implementation*, not Shopify's treatment of encoded values.
3. **The App Proxy prefix is not configured.** Until it is registered in the Partner dashboard, the platform's callback
   reaches `https://{shop}/apps/kd-payments/...` and Shopify answers `404`, which the platform reports as a `404`
   outcome - the merchant sees "rejected", not "misconfigured".
4. **The app was written and run, never against Shopify.** The gate's Shopify side is a fake token endpoint and a fake
   proxy; a real install, a real consent screen and a real callback have not happened.
5. **A callback's outcome is memory only.** A restart loses the list, and nothing asks the platform again for the
   payments this shop created - the app has no key to ask with until a merchant types one.
6. **One payment per press, no amounts from Shopify.** The merchant types the order id and the amount; nothing reads the
   order from Shopify, because that is an Admin API call (gap 1). A wrong amount is a wrong payment.
7. **No UI on the platform side.** A merchant's dashboard still has no screen listing store payments or callbacks; the
   chain has the entries, the app has the list, and nothing joins them for a merchant.
8. **The Shopify app is still not approved, standalone and missing its GDPR webhooks**, exactly as STEP 210 left it. This
   STEP adds no webhook and no App Bridge work.
9. **Two platforms, one ambiguity rule.** A tenant with an active WooCommerce shop and an active Shopify shop is refused
   `connection_ambiguous` on every callback, because STEP 203's payment row names no store. A `store_connection_id` on
   the payment would fix it, and it is a migration no STEP in this range owns.
10. **The callback's envelope is trusted once Shopify signed the transport.** The app cannot ask the platform what the
    payment is (no key), so it records what the platform said. A wrong status would be recorded wrongly - which is why
    it records rather than applies.

---

## Next

**STEP 212: Plan creation by super_admin with price, period and services** — the first of the billing range, and a
different world: `services/billing/`, the office screens, and a migration this STEP's range owns. Nothing in STEP 211
depends on it, and nothing in it depends on STEP 211.
