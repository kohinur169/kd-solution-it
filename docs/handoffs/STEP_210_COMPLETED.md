# STEP 210 — Shopify app connection with credential login after install

Status: **complete**. Commit `STEP 210: Shopify app connection with credential login after install` on
`arena/65533bbe-kd-solution-it`, branched from STEP 209's `8c65f44`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **82 gate lines**, this STEP's gate is `lib/api/verify-shopify-connection.ts` at
**555 checks**, mutation-checked with **41 mutations, 41 caught**. The Shopify app package is **executed** by that gate
over a real socket - install, callback, login, status, disconnect and every refusal - so the behaviours below are
re-run on every `npm run verify` rather than recorded once.

## STEP

From `docs/final/STEP_PLAN_250.md:2678`:

> **210. Shopify app connection with credential login after install**

FEATURE_LIST §20 (`:217`) is the sentence:

> Shopify: the platform has its own Shopify app with approval. A merchant installs the app and logs in with credentials,
> and the connection becomes active and fully functional automatically.

The launch checklist (`:315`) adds the release half of the same sentence: *"Shopify app created and approved so
merchants can install it and connect with credentials."* Creating and approving the app is a release action, not code;
it is carried as a gap below, exactly as STEP 208 carried the plugin's publication.

## Order, and the gap this STEP sits inside

Implemented immediately after 209 at the owner's instruction. **STEPs 211-230 still have no handoff and no code in this
tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing here
depends on the missing range: it reads `0035`'s table (STEP 023), STEP 202's pipeline and STEP 208's connection
vocabulary.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/shopify-connection-fields.ts` | new | 189 | The vocabulary: the `stores/shopify/connection` resource, the `myshopify.com` identity and its handle bounds, the two access-token prefixes and the two that are refused, the body ceiling, the seven shop/token rules, the appended connection rules, the column list taken from STEP 208 |
| `lib/api/shopify-connections.ts` | new | 707 | The service: the shop normaliser and validator, the token validator, the body reader and parser, the tenant fence, the connect that inserts, reuses or refuses, the status read and the disconnect |
| `lib/api/shopify-connection-runtime.ts` | new | 28 | The production wiring: STEP 023's REST client and chain, the clock, and the sealer that reads `ENCRYPTION_MASTER_KEY` |
| `app/api/public/v1/stores/shopify/connection/route.ts` | new | 150 | `POST` the login after install, `GET` the status, `DELETE` the disconnect, all through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-shopify-connection.ts` | new | 2270 | The gate: a PostgREST-shaped fixture over `store_connections`, the three states, the race, the pipeline, a file-by-file review of the app, and the app itself driven over a real socket |
| `plugins/shopify/kd-payments-app/**` | new | 1885 | The platform's own Shopify app: `src/server.mjs`, `src/shopify.mjs`, `src/session.mjs`, `src/platform.mjs`, `src/screen.mjs`, `src/copy.mjs`, `src/config.mjs`, `config.example.json`, `package.json`, `readme.txt` |
| `package.json` | edited | +1 script, +1 link | `check:shopify`, and one link in the `verify` chain after `check:store-callback` |

Ownership follows `STEP_PLAN_250.md:120-122` — API and Plugin STEPs 200-211 own `app/api/public/`, `lib/api/` and **the
plugin source folders**. `package.json` is the integrator-owned shared file, touched for one script and one chain link.

**No migration.** `0035_store_connections.sql` already holds the platform list (`shopify, woocommerce`), the four
states, the bare lower-case domain, the token's box and tail, the identity guard, the reseal guard, the revocation
guard, the unique domain index and RLS. The next free number stays **129**, and the migration gate is unchanged at
3778 checks, 128 migrations, 99 tables.

## What the handshake is, and what is genuinely different from STEP 208

STEP 208 connected a WooCommerce store with a token **the store minted for itself**. Shopify mints the token, and that
one sentence changes four things:

| | WooCommerce (STEP 208) | Shopify (this STEP) |
| --- | --- | --- |
| Who mints the token | the plugin, with `random_bytes(32)` | **Shopify**, at the end of its own OAuth consent |
| What the token is for | the platform calls the shop's own `wc-api` route | the platform calls Shopify's Admin API **with** it |
| What the domain is | any host a WordPress can run on | **only** `<handle>.myshopify.com`, Shopify's permanent identity |
| What identifies the merchant | the API key, because the shop has no account here | the API key, **after** the install, because Shopify knows the shop and not the company |

The third row is the security decision of this STEP. A Shopify custom domain is a pointer the merchant can repoint at
will; sealing an Admin API access token to a pointer is how a token ends up presented to a host nobody vetted. The
surface therefore refuses a custom domain with `422 shop_domain_not_myshopify` rather than reducing it to a guess, and
the unique index on `(company_id, platform, store_domain)` then means one shop cannot be connected twice through two
hostnames.

The fourth row is the plan's phrase *"credential login after install"*. Shopify's install tells the app which shop
consented; it says nothing about which merchant on this platform owns it. The public API key is the only thing that can
say that, it is revocable without touching the merchant's account, and STEP 202 already authenticates, counts and
records it.

## The three states a row can already be in

| The row | The answer | Written |
| --- | --- | --- |
| none | `200`, the new connection, `reused: false` | insert `active`, sealed token, `connected_at`, derived `external_store_id` |
| `active`, same token tail | `200`, the connection that stands, `reused: true` | nothing |
| `active`, different token tail | `409 { field: "connection", rule: "connection_token_mismatch" }` | nothing |
| `revoked` | `409 { field: "connection", rule: "connection_revoked" }` | nothing |
| `pending` / `error` | `200`, activated in place, `reused: false` | status, `connected_at`, `last_error: null` only |
| inserted concurrently | `200`, the row that won, `reused: true` | nothing (the unique index chose the winner) |

Same three answers STEP 208 chose, for the same reasons: `0035` refuses to reseal a token under a raised key version, and
refuses to bring a revoked connection back. The **only** difference this STEP introduces is that its token is not
re-derivable by the caller, so the tail comparison is the entire reinstall story: a shop holding a token this platform
does not have is not "connected", it is a shop whose Admin API calls will be refused later.

## The app: what it does, and why it keeps nothing

`plugins/shopify/kd-payments-app/` is a dependency-free Node 22 package: six ES modules, no framework, no SDK, no build
step. Its flow is the section 20 sentence, in order.

1. **Install.** Shopify calls `GET /auth/install?shop=...&hmac=...&timestamp=...`. The app verifies the signature with
   its client secret, refuses a missing, repeated, stale or future-dated parameter, creates a server-side session, and
   redirects the browser to `https://{shop}/admin/oauth/authorize` with the scopes and a state it minted.
2. **Consent.** Nothing of this app runs.
3. **Callback.** `GET /auth/callback?code=...&shop=...&state=...&hmac=...`. The signature is verified again, the state
   is compared in constant time, the shop must be the one the install named, and the code is exchanged server to server
   at `https://{shop}/admin/oauth/access_token` with `redirect: "error"` so a redirect cannot carry the secret elsewhere.
4. **Token held, not stored.** The token lives in the process's memory under the session, never in a cookie, a page, a
   log line or a file, and the session identifier is rotated the moment the session starts carrying it.
5. **Credential login.** `GET /` shows the form. The merchant pastes their public API key; the app posts
   `{shop_domain, access_token}` to the platform with that key, and the platform seals the token and answers.
6. **Token forgotten.** The app deletes the token from the session before it writes the page that says the shop is
   connected. From then on the platform is the only place it lives, and the app holds **no merchant key at all** -
   `POST /status` and `POST /disconnect` ask for it again, every time.

Every sentence the page says comes from `src/copy.mjs`, one frozen catalog of titles, details, labels and the three
placeholders (`{shop}`, `{rule}`, `{status}`) that `fill` substitutes - the app carries its own catalog because it is a
separate deployment that cannot import `lib/i18n/strings/en.ts`, which is the same choice the WooCommerce plugin makes
with `esc_html__`. Every form carries a CSRF token compared in constant time against the session's; every printed value
goes through one `escapeHtml`; every answer carries `no-store`, `default-src 'none'`, `frame-ancestors 'none'`, `DENY`
framing and no referrer; every log line is one JSON object naming an event, a shop, a rule and a status - never a key, a
token, a code or a signature.

**Every failure page is a way out.** A page rendered without a session has no CSRF token, so every form on it answers
`403` - a dead end disguised as an error message. `sendFailure` therefore creates or renews the session exactly as
`GET /` does, and the cookie travels back with the refusal, so "check the connection" works on the page a merchant
lands on. That defect shipped in this STEP's first commit and is the first thing the resume closed; the gate now pins it
both as source (`token = ensureSession(sessionOf(request))`, no `csrf: ""`) and as behaviour (a refusal page's own token
is replayed against the platform, and a sessionless form still gets a usable page).

## The app, exercised

This is the part STEP 208 and 209 could not have. There is no PHP in this environment, so their plugin packages were
reviewed as source and never run; the Shopify package is JavaScript, so **the gate runs it**: the real handler behind a
real `http.Server` on `127.0.0.1:0`, driven with real requests, against a fake Shopify token endpoint and a fake
platform. Seventy-four assertions in section 15, re-run on every `npm run verify` - not recorded once and lost.

| Behaviour | Checks |
| --- | --- |
| `GET /healthz`, `GET /`, the viewport, the session cookie, and no token anywhere in it | 7 |
| Install: a signed redirect on the shop's own host, comma-separated scopes, a minted state, and the app's own callback addressed - with a repeated parameter refused `400` on a page that still carries a live CSRF token | 11 |
| Callback: a wrong state refused `400 state_mismatch` with **no** code exchange, then `302` and exactly one exchange carrying the secret and the code in a form body with no redirect followed | 6 |
| Credential login: the panel, a CSRF token, a password field, the token absent, a wrong CSRF token refused `403` | 5 |
| Connect: `200`, `Connected`, the tail shown and the token never, one platform call with the key as `Bearer`, no redirect, and a body of exactly two fields | 12 |
| After the login: still connected, a second login refused `409` on a usable page, and no second platform call | 5 |
| `POST /status` (a `GET` with the shop in the query) and `POST /disconnect` (`DELETE`) | 5 |
| A platform `409` reported as `409` **and retryable from the page it lands on**, a refused key `400` before any call, an unreachable platform `502` | 8 |
| A form from a session the app has never seen: refused `403`, on a page that still carries a usable CSRF token and hands back the session it just created | 3 |
| A forged cookie, a `GET` on a form endpoint `405`, an unknown path `404`, and the security headers on an answer that is not a page | 6 |
| Shopify's own refusals: a shared secret answered as a token (`token_wrong_kind`) and a token that expires (`token_not_offline`), neither reaching the platform | 6 |

What none of it can prove is a **real** Shopify install: there is no partner app here and no public https host to
register, so the first real install is still the first real proof.

## What the gate proves (15 sections, 555 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration (still 128 / 99 tables); `0035`'s platform list already naming `shopify`, its unique domain index, the frozen domain, the reseal guard, the revocation guard, the identifier column and the sentence that calls the sealed column the token the platform calls the store with |
| 2 | The resource path and route constant, the object name, STEP 208's column list **pinned as a literal**, three verbs and no `PUT`/`PATCH`, three route constants, three addresses, the query field read by name, no cookie, no CSRF, nothing printed |
| 3 | The shop: six accepted and normalised forms, seventeen refused with their own rule - four missing, six not-bare, three not-myshopify (a custom domain among them), four invalid - the suffix pinned, the handle ceiling pinned, the longest legal shop pinned at **74**, and the pattern proved to enforce both the suffix and the ceiling |
| 4 | The token: `shpat_` and `shpca_` accepted, trimming, the two prefixes **and** the two foreign ones pinned as literals, nine refusals including an app's shared secret and another app's delegate token, the bounds pinned to `16`/`96`, the total pinned to `102`, and the pattern's own quantifier |
| 5 | The body: the two values, the shop normalised, no third key, nine refusals naming their field (`status`, `platform`, `store_domain`, `external_store_id` all `unknown_field`), a declared and an undeclared body past 1 KiB both `413`, and a body that is not JSON |
| 6 | The install: one insert into one table with one row - company, platform, normalised shop, `active`, the instant, `revoked_at` null, `last_error` null, key version 1, the tail, a box, no plaintext anywhere - a recomputed identifier the gate hashes itself, the seal called once under the **literal** associated data, the box opened under its own context and refused under another merchant's, another shop's and the other platform's, and the ciphertext column named exactly once in the whole service |
| 7 | The three states and the race: reuse with **no write and no insert** and `reused: true` in the chain; a tail mismatch as `409 connection_token_mismatch` with the refusal recorded; `409 connection_revoked` with nothing written; a pending row activated with exactly `connected_at,last_error,status` under its version, its tenant and its platform; a lost compare-and-set as `writeNotApplied`; a version that jumped by two refused; a conflicted insert answering the winner `reused: true`, and a conflicted insert that finds a revoked row or another token as its own rule |
| 8 | The read: the domain, tenant, platform, `deleted_at` and `&limit=1` fences, the column list, never a star and never the box's three columns; four kinds of "not yours" as one `404 not_connected`, each with its chain entry; a revoked row still readable; and a **twin row of the same shop on WooCommerce that this surface must not answer** |
| 9 | The disconnect: revocation with exactly `last_error,revoked_at,status` at the platform's instant, the chain entry naming the platform the row carries and never the token, a second disconnect answered with the revoked row and **no write and no entry**, and a `404` for a shop that is not connected |
| 10 | The answer: twelve fields on a connect, no token, no ciphertext, and no value of either anywhere in it |
| 11 | Through the pipeline: `200` with the version header and `no-store`, three counters, one `api.call` under the resource's route, a keyless call `401` before any handler, a refused counter `429` before the handler, and a deaf chain that neither refuses a connection nor loses the row |
| 12 | The chain: the three actions and the entity pinned to their literals, the activation's platform, shop, status, `reused`, mode, credential and tail, never the token or the key, every rule snake case and unique, and the four states read out of the migration |
| 13 | The app, file by file: seven modules and no eighth, a private package with **no dependency**, a path comment and no `console`/`process.env`/`eval` in any of them, the signature refused **before** the shop is read, the repeated parameter, the both-ways timestamp, the constant-time comparison, Shopify's own escaping of `%`, `&` and `=`, the token endpoint on the shop's own https host with the secret in the body, no redirect followed, no hang, the short-lived token refused, the two foreign prefixes refused in the app too, the token stored once and cleared before the connected page, the rotated identifier, the cookie's four attributes, the CSRF **guard** (not merely a call), the bounded form, the platform client's key shape check and no redirect, the escaping function proved to replace all five characters, the password field, the framing and caching policy, an example configuration with no real value, and a readme that names App Bridge, the GDPR webhooks, the uninstall path and the fact that the package is not published |
| 14 | The screen, the copy and the way out of a failure: one frozen catalog, every notice routed through one filler, five sentences pinned as living **only** in the catalog, one `sendFailure` that renews the session and no `csrf: ""` anywhere in the app, a viewport, a small-screen rule that folds the definition list, a focus ring that is never removed, `box-sizing`/`width:100%`/`word-break`, a touch-sized control, and labels counted **equal** to inputs so a new field cannot arrive unlabelled |
| 15 | The app over a socket: the whole install-to-disconnect flow, the two Shopify refusals, the platform's `409` and `502`, the sessionless form, and a retry **from** a refusal page - each a behaviour, not a regex |

### The mutations

Forty-one, each restored immediately, **41 caught**: the platform renamed; the suffix loses a letter; the handle floor
dropped; the token-exchange prefix dropped; the body ceiling at a megabyte; the resource loses its platform segment; a
rule renamed; the column list grows the ciphertext; the platform fence pointed at the other platform; deleted rows
readable; the read asking for ten rows; a revoked connection reactivated; an active connection ignoring a different
token; the seal context naming the other platform; the install writing `pending`; a key version the runtime did not
use; the write losing its version guard; the read-back proving nothing; a second disconnect writing again; the chain
claiming the other platform; a port accepted in a shop domain; a shared secret accepted as a token; the disconnect verb
removed; the caller's address dropped; the signed message leaving `=` unescaped; the signature compared with `===`; a
repeated parameter resolved rather than refused; the token exchange following redirects; the app sending a shared
secret; any string treated as a key; the CSRF check removed; the session keeping the token after the login; the escaping
removed; the cookie losing `HttpOnly`, and separately `Secure`; a failure page rendered beside its session; the
viewport removed; the focus ring set to `none`; the small-screen rule removed; the renderer writing its own sentence
instead of reading the catalog; and the catalog's filler returning its template unfilled.

The first round caught 25 of 35. Nine were **gate weaknesses**, not code defects, and every one was the same shape: a
check against a comment or a definition rather than the code that acts. `redirect: "error"` was asserted against the
whole file, which carries the phrase in a doc comment, so it is now asserted against the function body; the CSRF check
looked for a call where the definition alone satisfied it, so it now looks for the **guard**; `HttpOnly` and `Secure`
matched the prose above the array, so they are now pinned as the quoted literals; `escapeHtml` was only asserted to
exist, so the gate now pins the `replace` over all five characters; and the revocation chain's platform was unpinned
until a behavioural check was added. The tenth was an equivalent mutant (a hardcoded platform where the row's platform
is always the same string), and it was replaced with a mutation that changes behaviour.

## Security

- **Authentication** - the merchant's public API key through STEP 202's pipeline: counted in three buckets, recorded
  once, `401` before any handler, and the key's mode carried into the chain because the connection row has no mode.
- **Tenant isolation** - every query of the surface carries `company_id=eq.` from the principal, `platform=eq.shopify`
  and `deleted_at=is.null`; another merchant's shop answers the same `404` a nonexistent one does, and a twin row of the
  same shop on the other platform is never answered by this resource.
- **The shop's identity** - Shopify's permanent `myshopify.com` host, refused otherwise, so a token is never sealed
  against a hostname a merchant can repoint.
- **The token** - shape-checked before it is sealed, sealed once under an associated data binding merchant, platform
  **and** shop, never selected back by any query of the service, never echoed, and compared only by its documented tail.
- **The computed facts** - `status`, `connected_at`, `external_store_id` and `revoked_at` are the platform's; a body
  that names any of them is refused as `unknown_field`.
- **Finality** - `0035`'s guard, not this endpoint's opinion: a revoked row cannot return and a sealed token cannot be
  resealed under the same key version. Both are the migration's `raise`.
- **The app** - a signed install query with a bounded timestamp and no repeated parameters, a state compared in constant
  time, a token exchanged server to server and never put in a URL, a page or a log, a memory-only session with a rotated
  identifier, a signed `HttpOnly`/`Secure`/`SameSite=Lax` cookie, CSRF on every form, a bounded form body, one escaping
  function, a narrow CSP, `DENY` framing, and **no stored merchant credential at all**.
- **The failure path** - a page that cannot be submitted is a dead end, so every refusal renders through `sendFailure`,
  which creates or renews the session and returns its cookie with the refusal; the gate pins that as source and proves
  it as behaviour (a refusal page's own token is replayed, and a sessionless form still gets a usable page). No notice
  is written at a call site and no page is rendered with an empty token; the catalog is the only place a merchant-facing
  sentence exists.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-shopify-connection.ts` | exit 0 - "shopify connection gate passed: 555 checks" |
| the app itself, inside that gate (section 15) | the install, callback, login, status, disconnect and every refusal, over a socket, on every run |
| `node /tmp/shopify-smoke.mjs` (not committed) | 57/57 checks - the same flow driven once by a throwaway script, kept as a second witness |
| `npm run verify` | exit 0 - **82 gates**, including the moved checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 815 source files, audit 4667 |
| `npm run build` (inside `verify`) | compiled; the route table lists `ƒ /api/public/v1/stores/shopify/connection` |
| Mutation round | 41 mutations, **41 caught** |

The smoke ran the production build against `.env.example`'s placeholder environment (`npx next start -p 3410
-H 0.0.0.0`, since removed), with no database behind the placeholder URL:

```
POST   connection, no key                     -> 401 AUTHENTICATION_REQUIRED      (refused at the pipeline)
POST   connection, "Bearer nope"              -> 401 AUTHENTICATION_REQUIRED      (malformed, no query)
GET    connection, no key                     -> 401 AUTHENTICATION_REQUIRED
PUT    connection                             -> 405                              (the framework's, three verbs)
POST   connection, kd_test_... key            -> 502 DEPENDENCY_FAILED, retryable  (no database behind the placeholder)
GET    connection, kd_test_... key, no shop   -> 502 DEPENDENCY_FAILED, retryable  (authenticated before the query)
DELETE connection, kd_test_... key            -> 502 DEPENDENCY_FAILED, retryable
```

Every branch behind that point - the shop rules, the token kinds, the three states, the race, the sealing context, the
chain - is proven in the gate against a PostgREST-shaped fixture, because a real database and a real Shopify app are not
available in this environment.

## Provider documentation

MASTER_PROMPT's Provider Documentation Rule asks for the provider's own documentation to be fetched and recorded before
adapter code is written. **That fetch was not possible in this environment**: `shopify.dev` and `shopify.com` are both
refused at the network layer (TLS handshake failure), so the app was written from the documented shapes this repository
could reach and from Shopify's published behaviour as reported in public sources, not from a page this session opened.
The canonical URLs a later STEP must verify before STEP 211's Admin API code is written are recorded here, **unverified
by this session**:

- `https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens` (token kinds and the token endpoint)
- `https://shopify.dev/docs/apps/auth/oauth` (install, the signed query, the state)
- `https://shopify.dev/docs/api/admin-graphql` (the GraphQL Admin API STEP 211 needs)
- `https://shopify.dev/docs/apps/launch/privacy-requirements` (the three mandatory GDPR webhooks)

`docs/final/PROVIDER_DOCS.md` was **not** edited: it is owned by the adapter STEPs 147-169, and this STEP adds no
adapter. The four URLs above are the request to whoever owns that file.

## Carried gaps (named rather than hidden)

1. **The app has never talked to Shopify.** It is run end to end by the gate against a fake token endpoint and a fake
   platform, so its own logic, its HTTP handling, its escaping and every page a merchant can reach are proven; the
   *Shopify* half - a real install, a real consent screen, a real token - has not happened. That is the first thing to
   do, and it needs a registered app and a public https host.
2. **The app is not registered or approved.** FEATURE_LIST `:315` requires the app created and approved at launch;
   creating it in the Partner dashboard, requesting scopes, answering the listing questions and passing review are
   release actions.
3. **It is a standalone app, not an embedded one.** App Store review requires the latest App Bridge in an embedded app,
   and embedded apps need session tokens this package does not verify. Publishing it as written would fail review; the
   readme says so.
4. **The three mandatory GDPR webhooks are not answered** (`customers/data_request`, `customers/redact`,
   `shop/redact`). Review requires them even for an app that stores no customer data. The platform stores a shop token,
   which `shop/redact` is exactly about.
5. **`app/uninstalled` is not handled.** If a merchant uninstalls without pressing Disconnect, the row stays `active`
   and its token is one Shopify has already revoked: every later call will fail with a `401` from Shopify rather than
   from this platform. The webhook is HMAC-verified with the app's secret and belongs to the app package, which now
   exists; wiring it to `DELETE …/connection` needs the app to hold something it does not hold today (a merchant key)
   or a platform-side revoke-by-shop-id route neither this STEP nor 211 owns.
6. **The app holds no merchant key, so nothing is automatic after the first login.** A merchant who wants to see or
   revoke a connection types the key again. That is deliberate, but it means an app-side "connected" badge is not
   possible without storing a credential, which is worse.
7. **Sessions are memory only.** A restart mid-install loses the token and the merchant reinstalls. The alternative -
   writing an access token to disk - is the thing this design exists to avoid.
8. **Nothing calls Shopify yet.** This STEP is the handshake and the row; the Admin API calls that use the sealed token
   are STEP 211's, and no other surface in the tree reads `store_connections` for `shopify` today.
9. **A token is compared by its last four characters.** That is the only part `0035` lets a screen see, so a shop that
   presents a different token with the same tail is answered `reused` - a 1-in-65 536 coincidence, and the alternative
   is reading the ciphertext on every handshake, which this surface deliberately never does.
10. **No UI on the platform side.** §20's credential screen (STEP 200) is where a merchant creates the key this app
    pastes; no screen lists a merchant's store connections, and this STEP does not add one.
11. **The screen's layout is proved structurally, not in a browser.** The gate pins the mechanisms - a viewport, a
    fluid width, `@media (max-width:30rem)`, `box-sizing`, `word-break`, a touch-sized control, a focus ring that is
    never removed - but nothing here renders CSS or measures a phone. A screenshot at 360 px is a manual check.
12. **GraphQL only.** Shopify's review rules require new public apps to use the GraphQL Admin API. STEP 211 must write
    against `admin/api/{version}/graphql.json`, not the REST endpoints this handoff's vocabulary does not mention.

## Resume addendum

This STEP's first commit was audited slice by slice against the files it claims to own, and **one of the eight slices
did not hold up**. Three things were wrong; all three are now closed in the tree, in the gate and in this document.

| Found | Why it mattered | Closed by |
| --- | --- | --- |
| **Every failure page was a dead end.** `renderPage` was called with `csrf: ""` on all four failure paths, so the form on a refusal page answered `403` - a merchant told to "check the connection" could not press the button it offered | The one path a merchant is most likely to see was unusable, and the WooCommerce plugin (STEP 208) does not have this defect, so it was this STEP's regression | `sendFailure` creates or renews the session and returns its cookie with the refusal; the gate pins the source **and** replays the refusal page's own token to the platform, and separately proves a sessionless form still gets a usable page |
| **Merchant-facing sentences were scattered** across `screen.mjs` and `server.mjs`, some inline at the call site | MASTER_PROMPT rule 1 asks for one catalog, and a scattered string cannot be reviewed, translated or consistency-checked - the WooCommerce plugin keeps its copy in `render-admin-page.php`'s one helper | `src/copy.mjs`: one frozen `COPY` object (brand, install, credentials, connected, fields, twelve notices) with `{shop}`, `{rule}`, `{status}` placeholders and one `fill`; every notice now goes through `noticeOf` and every page renders only from the catalog |
| **No mobile or focus rules.** Fixed `max-width` only, no viewport behaviour beyond the meta tag, no `@media`, no visible focus ring, no touch-sized control | A merchant installs from a phone or a tablet; a form that is unreadable at 360 px or unfocusable by keyboard is not "fully functional" | The stylesheet is fluid (`width:100%`, `max-width`, `box-sizing`), folds the definition list under 30 rem, keeps a `:focus-visible` ring on every control, sizes buttons to 2.75 rem and breaks long shop domains |

The first defect was found by trying the thing rather than reading it: a throwaway script fetched a refusal page, read
`csrf` out of it, and replayed it - `refusal page status=409, csrf=EMPTY` and then `403` on the retry. The same script
after the fix reads a real token and reaches the platform's own `409`. That is why the gate now carries the flow as
behaviour: reading the source would not have caught it, and neither would the 57/57 smoke, which never re-submitted a
failure page.

The audit also re-confirmed the other seven slices at the audited commit - the migration untouched at 128 / 99, the
route wired into the production build, the service's sealing context, the three states, the pipeline, the chain and the
provider documentation request - and left them alone.

---

## Next

**STEP 211: Shopify app payment and callback handling** - the Shopify counterpart of STEP 209, using the sealed token
this STEP leaves in `store_connections`. It will need the GraphQL Admin API documentation fetched and recorded, a
callback path a Shopify app can own (Shopify does not call a shop's own route the way WooCommerce's `wc-api` does), and
the same "ask the platform, never the shop's body" rule STEP 209 proved.

The next free migration number remains **129**. `docs/final/PROVIDER_DOCS.md` is still unowned by this range.
