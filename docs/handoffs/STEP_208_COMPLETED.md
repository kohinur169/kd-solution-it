# STEP 208 — WooCommerce plugin connection with credential login

Status: **complete**. Commit `STEP 208: WooCommerce plugin connection with credential login` on
`arena/ca936761-kd-solution-it`, branched from STEP 207's `1207fff`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **80 gate lines**, this STEP's gate is `lib/api/verify-woocommerce-connection.ts` at
**451 checks**, mutation-checked with **52 mutations, 52 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2654`:

> **208. WooCommerce plugin connection with credential login**

FEATURE_LIST §20 (`:218`) is the sentence:

> WooCommerce: the platform has its own plugin. A merchant logs in with credentials in the plugin and the connection
> becomes active automatically.

The launch checklist (`:315`) adds the other half of the same sentence: the plugin package has to be **published** for
merchant stores before launch. Publishing is a release action, not this STEP's code — it is carried as a gap below.

## Order, and the gap this STEP sits inside

Implemented immediately after 207 at the owner's instruction. **STEPs 209-230 still have no handoff and no code in this
tree**, so the plan's numeric order remains broken and the gap is recorded rather than smoothed over. Nothing here
depends on the missing range: it depends on `0035`'s table (STEP 023), STEP 202's pipeline and STEP 200's credential
model.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/store-connection-fields.ts` | new | 212 | The vocabulary: the `stores/woocommerce/connection` resource, the platform and state lists `0035` already declares, the domain and token bounds, the associated data of a store token, the ten rules, the three chain actions, the read's column list and the answer shapes |
| `lib/api/store-connections.ts` | new | 730 | The service: the domain normaliser and validator, the token validator, the body reader and parser, the tenant fence, the connect that inserts, reuses or refuses, the status read and the disconnect |
| `lib/api/store-connection-runtime.ts` | new | 28 | The production wiring: STEP 023's REST client and chain, the clock, and the sealer that reads `ENCRYPTION_MASTER_KEY` |
| `app/api/public/v1/stores/woocommerce/connection/route.ts` | new | 147 | `POST` the login, `GET` the status, `DELETE` the disconnect, all through STEP 202's authenticate-count-record pipeline |
| `lib/api/verify-woocommerce-connection.ts` | new | 1698 | The gate: a PostgREST-shaped fixture over `store_connections`, the three states, the race, the pipeline, and a file-by-file review of the plugin |
| `plugins/woocommerce/kd-payments/**` | new | 848 | The platform's own WooCommerce plugin: `kd-payments.php`, `includes/class-kd-api-client.php`, `includes/class-kd-connection.php`, `includes/class-kd-settings.php`, `readme.txt` |
| `package.json` | edited | +1 script, +1 link | `check:woocommerce`, and one link in the `verify` chain after `check:sandbox-webhook` |

Ownership follows `STEP_PLAN_250.md:120-122` — API and Plugin STEPs 200-211 own `app/api/public/`, `lib/api/` and **the
plugin source folders**. `package.json` is the integrator-owned shared file, touched for one script and one chain link.

**No migration.** `0035_store_connections.sql` already holds everything this STEP writes: the two platforms, the four
states, the bare lower-case domain with its pattern, the token's box and tail, the identity guard, the reseal guard, the
revocation guard, the unique domain index and RLS. The next free number stays **129**, and the migration gate is
unchanged at 3778 checks, 128 migrations, 99 tables.

### The plugin folder had to be created, and there is no PHP here

`:122` grants "the plugin source folders", but **no such folder existed** and this environment has **no PHP interpreter**
(`which php` is empty — the runtime is Node only). Two honest consequences, both handled rather than hidden:

1. **The folder now exists as the real package**: `plugins/woocommerce/kd-payments/`, a WordPress plugin with the header
   WordPress reads, `readme.txt`, an `includes/` folder and four PHP files. It is not a stub: it is the login, the
   status, the disconnect, the screen, the nonce, the escaping and the transport, complete.
2. **It was never executed.** No `php -l`, no WordPress, no WooCommerce in this environment. The gate therefore reviews
   the plugin **as source** — 110 of its 451 checks are PHP-side assertions — and one of them is the only mechanical
   syntax check available here: every file's braces, brackets and parentheses are walked outside strings and comments
   and must balance. The handoff says plainly that this is not a parser, and the gap is listed at the end.

`config/structure.json` was **not** touched. `plugins/` is outside the structure gate's source roots, so the
convention those roots enforce (`// path: <repo path>` first line, no forbidden markers) does not apply to PHP; the files
carry the comment anyway for consistency, and `check:woocommerce` reviews them instead. The structure checkpoints move
only because of the five new TypeScript files: **17 directories, 14 root files, 805 source files**.

## The call, in one paragraph

A merchant installs the plugin, pastes the **public API key** from Developers → API credentials, and presses **Connect**.
The plugin reads its own domain off the site (`home_url()`), takes the token it minted on activation, and posts both to
`POST /api/public/v1/stores/woocommerce/connection` with the key as a bearer token. The platform authenticates the key
through STEP 202's pipeline, normalises the domain, validates the token's shape, seals the token under an associated
data that names the merchant, the platform **and the domain**, and inserts one `store_connections` row that is already
**active** — no approval queue, no operator, exactly as the FEATURE_LIST sentence says.

`GET …?store_domain=…` answers the connection, `DELETE …?store_domain=…` revokes it.

## The three states a row can already be in

| The row | The answer | Written |
| --- | --- | --- |
| none | `200`, the new connection, `reused: false` | insert `active`, sealed token, `connected_at`, `external_store_id` |
| `active`, same token tail | `200`, the connection that stands, `reused: true` | nothing |
| `active`, different token tail | `409 { field: "connection", rule: "connection_token_mismatch" }` | nothing |
| `revoked` | `409 { field: "connection", rule: "connection_revoked" }` | nothing |
| `pending` / `error` | `200`, activated in place, `reused: false` | status, `connected_at`, `last_error: null` only |
| inserted concurrently | `200`, the row that won, `reused: true` | nothing (the unique index chose the winner) |

Two of those rows are the interesting ones.

**An active row is never rewritten.** `0035`'s guard raises `a store token is re-encrypted only under a new key
version` whenever the box's three columns change without `encryption_key_version` rising — so a second install cannot
replace the sealed token, and pretending otherwise would mean lying about which master key sealed it. The platform
therefore answers the connection that exists, and compares the **tail** the caller presented with the tail on file: a
store holding a token the platform does not have is not "connected", it is a store whose calls will be refused later.
That is a `409`, not a success.

**A revoked row stays revoked.** `0035` says it in a raise: `a revoked store connection stays revoked`. Installing
again on the same domain is a support action, and the plugin's screen says so instead of looping.

## Why the store mints its own token

`0035` calls `access_token_ciphertext` *"the access token the platform will call the store with"*. The plugin generates
it on the store's own server with `random_bytes(32)` and keeps it; the platform seals what arrived. So the secret that
makes the two sides trust each other is **never transmitted back**, never displayed, and never has to be shown once to
be useful — a token the store already holds. The only part of it the platform will ever repeat is its last four
characters, which `0035` itself calls *"the only characters of the store token a screen may show"*.

## The domain: normalised, then validated

A plugin sends what the site thinks its address is, which is sometimes a URL. The platform **normalises and then
validates**, in that order, because a value the store believes it sent being quietly changed is how a merchant ends up
connected to a domain they did not mean:

| Sent | Stored |
| --- | --- |
| `shop.example.com` | `shop.example.com` |
| `Shop.Example.COM` | `shop.example.com` |
| `https://shop.example.com/` | `shop.example.com` |
| ` shop.example.com ` | `shop.example.com` |

and refused, rather than reduced, when a bare host cannot contain it: a path, a port, a query, a fragment, credentials
or a space is `422 store_domain_not_bare`; one label, a leading dash, an empty label or a domain past 253 characters is
`422 store_domain_invalid`; nothing at all is `422 store_domain_missing`. The stored value must satisfy `0035`'s own
pattern, which is why the pattern is **repeated** in the vocabulary module: a database `check_violation` is a refusal the
plugin cannot read.

## The plugin's own security

The plugin runs on somebody else's server, so its four rules are checked as source:

- **Direct access refused** — `defined( 'ABSPATH' ) || exit;` opens every file.
- **Capability, then nonce** — `authorise()` checks `current_user_can( 'manage_woocommerce' )` **before**
  `check_admin_referer( … )`, because a nonce proves intent and not permission; it is called by all four handlers, and
  every one of the four forms prints its own `wp_nonce_field`.
- **Escaped where it lands** — `esc_html`, `esc_attr`, `esc_url` and `esc_html__`, in that vocabulary, with
  `esc_html__` inside `wp_die` as well.
- **A transport that trusts nothing** — `wp_remote_request` with `sslverify => true`, `redirection => 0`, a ten-second
  timeout, the key as a bearer header, `wp_json_encode` for the body, and a transport error reduced to a machine word
  rather than printed.

Two secrets, both stored `'no'` — unautoloaded: the merchant's key (`kd_payments_api_key`) and the store's token
(`kd_payments_store_token`). The key is typed into a `type="password"` field with `autocomplete="off"`, sanitised with
`sanitize_text_field( wp_unslash( … ) )`, and **never printed back**. The screen's own notices are per-user transients,
so one merchant's failure is not shown to another account on the same site.

## What the gate proves (13 sections, 451 checks)

| Section | What it pins |
| --- | --- |
| 1 | No migration (still 128, 99 tables); `0035`'s platform list, four states, domain bounds and pattern, active/pending/revoked checks, "a store connection keeps its store", the reseal guard, the revocation guard, the unique domain index and the tail comment — read out of the migration, not restated |
| 2 | The route: three verbs and no `PUT`/`PATCH`, dynamic, the pipeline, the route **constant** three times (not a second copy of the path), the caller's address three times, the query domain for the two verb-less calls, no cookie, no CSRF, nothing printed |
| 3 | The domain: seven accepted and normalised (`Shop.Example.COM`, `https://…`, `http://…/`, trimmed, dashes, digits), fifteen refused with their own rule and `422` — four `domain_missing`, six `domain_not_bare`, five `domain_invalid` — and the pattern's own refusal of an upper-case domain |
| 4 | The token: sixty-four hex and base64url accepted, trimming, the bounds pinned to `32`/`128` **and** to the pattern's quantifier so the two cannot drift, padding outside the alphabet, and seven refusals with their own rule |
| 5 | The body: the domain normalised and the token kept; eight refusals (`{}`, no domain, no token, an array, null, a bare string, `status`, `external_store_id`); a non-JSON body; a declared and an undeclared body past 2 KiB, both `413` |
| 6 | The install: one insert into one table with one row — company, platform, normalised domain, `active`, `connected_at`, `revoked_at` null, `last_error` null, version 1, the tail, a box, and **no plaintext token anywhere in the row**; the seal called once under the literal associated data, opened under its own context and refused under another store's |
| 7 | The three states and the race: reuse with **no write and no insert** and `reused: true` in the chain; revoked as `409 connection_revoked` with nothing written and the refusal in the chain; pending activated with exactly `connected_at,last_error,status` and **never a token column**, guarded by version, tenant and platform; a tail mismatch as `409 connection_token_mismatch`; a tail that agrees reused; a lost compare-and-set as `writeNotApplied`; a version that jumped by two as `writeNotApplied`; a conflicted insert answering the winner `reused: true`, and a conflicted insert that finds a revoked row or another token as its own rule |
| 8 | The read: the domain, tenant, platform, `deleted_at` and `&limit=1` fences, the column list, never a star and never the box's three columns; four kinds of "not yours" as one `404 not_connected` with the refusal recorded; a revoked row still readable |
| 9 | The disconnect: revocation with exactly `last_error,revoked_at,status` at the platform's instant, the chain entry naming the row and never the token, a second disconnect answered with the revoked row and **no write and no entry**, and a `404` for a store that is not connected |
| 10 | The answer: twelve fields on a connect, ten on a status, no token, no ciphertext and no ciphertext value |
| 11 | Through the pipeline: `200` with the version header and `no-store`, three counters, one `api.call` under the resource's route, a keyless call `401` before any handler, and a deaf chain that neither refuses a connection nor loses the row |
| 12 | The chain: the activation entry's action, entity, null actor, company, address, platform, domain, status, `reused`, mode, credential and tail — never the token or the key; every action and rule pinned to its literal; `STORE_CONNECTION_OBJECT` equal to the entity name; the service naming the ciphertext column exactly once, in the insert |
| 13 | The plugin, file by file: four PHP files and a readme; the direct-access guard, and the absence of `eval`, `extract`, `create_function`, `unserialize`, `error_log`, `var_dump`, `print_r`, `$wpdb`, `$_GET`/`$_REQUEST` and bare `echo $` in all four; **balanced delimiters** in all four; the header fields, the `random_bytes` token, the three unautoloaded options, the https base and the filterable base; the client's `sslverify`, `redirection => 0`, timeout, bearer header, `wp_json_encode`, `is_wp_error`; the connection's `home_url()` domain, sanitised key and unautoloaded save; and the screen's capability-then-nonce order, four nonces, four authorise calls, escaped output and per-user notice |

### The mutations

Fifty-two, each restored immediately, **52 caught**. They are: the platform renamed to Shopify; the resource losing its
platform segment; the body ceiling at a megabyte; a single-label domain accepted; the token floor at eight; the token
alphabet losing `_`; three rules and three chain actions renamed; the read selecting the ciphertext; the associated
data losing its version and, separately, its domain; the answer renaming its object; a revoked connection reactivated;
an active connection ignoring a different token; the domain not lowered; a path in the domain accepted; the token
pattern not applied; an unbounded declared body; a non-strict schema; the install writing `pending`, or no instant, or
a fake tail, or the wrong key version, or no identifier, or a token sealed without the domain; deleted rows readable;
the platform fence dropped; the status read asking for ten rows; the write not guarded by its version; the read-back
ignoring the version; a second disconnect writing again; the chain claiming a reuse; the chain losing the caller's
address; the route inventing its own path or losing `DELETE`; the nonce not checked or a form losing it; the capability
leaving the handler; the refusal page not escaped; the transport stopping TLS verification, following redirects, losing
its timeout or sending no key; the key not sanitised; the token not random, or not thirty-two bytes; the options
autoloading; a file skipping its direct-access guard or losing a brace; and the base not https.

The first round caught 44 of 51 and one needle matched nothing. **All seven misses were gate weaknesses, and every one
of them was a comparison against a value the test itself could rename**: `STORE_CONNECTION_OBJECT` compared with
`STORE_CONNECTION_OBJECT`, `storeExternalIdOf` with `storeExternalIdOf`, the associated data with the function that
builds it, the token floor with a pattern that independently enforced the same floor, and three `includes` checks that
a second occurrence elsewhere in the file satisfied. The fixes were literals: the object pinned to `"store_connection"`,
the identifier recomputed in the gate from `sha256` of the identity, the associated data pinned to
`kd-aad-v1|store_connection|<company>|woocommerce|<domain>`, the token bounds pinned to `32`/`128` **and** to the
pattern's own quantifier, both `wp_die` pages counted, both unautoloaded options pinned line by line, the read's limit
asserted at the **end** of the query (`&limit=1`, not the `limit=1` inside `limit=10`), and the capability check
required **inside** the function every handler calls rather than anywhere in the file.

## Security

- **Authentication** — the merchant's public API key, through STEP 202's pipeline: counted in three buckets, recorded
  once, `401` before any handler, and the key's mode carried into the chain because the connection row itself has no
  mode.
- **Tenant isolation** — every query of the surface carries `company_id=eq.` from the principal, `platform=eq.woocommerce`
  and `deleted_at=is.null`; a status check names its domain, and another merchant's domain answers the same `404` as a
  domain that does not exist.
- **The store's token** — validated, sealed under an associated data binding merchant, platform **and** domain, written
  once, never selected back by any query of the service, never echoed, and compared only by its documented tail.
- **The computed facts** — `status`, `connected_at`, `external_store_id` and `revoked_at` are the platform's; a body
  that names any of them is refused as `unknown_field`, so a plugin cannot claim its own activation or pick its own
  identifier.
- **Finality** — `0035`'s guard, not this endpoint's opinion: a revoked row cannot return, and a sealed token cannot be
  resealed under the same key version. Both are the migration's `raise`, both are read out of it by the gate.
- **The plugin** — capability before nonce, escaping at every print, `sslverify`, no redirect, no SQL, no eval, no
  logging, and two unautoloaded secrets.

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `node lib/api/verify-woocommerce-connection.ts` | exit 0 — "woocommerce connection gate passed: 451 checks" |
| `npm run verify` | exit 0 — **80 gates**, including the moved checkpoints: migrations 3778 / 128 / 99, i18n 3228 / 343, structure 805 source files, audit 4597 |
| `npm run build` (inside `verify`) | ✓ compiled; the route table lists `ƒ /api/public/v1/stores/woocommerce/connection` |
| Mutation round | 52 mutations, **52 caught** |

The smoke ran the production build against `.env.example`'s placeholder environment (`npx next start -p 3408
-H 0.0.0.0`, since removed), with no database behind the placeholder URL:

```
POST   connection, no key                      → 401 AUTHENTICATION_REQUIRED      (refused at the pipeline)
POST   connection, "Bearer nope"               → 401 AUTHENTICATION_REQUIRED      (malformed, no query)
PUT    connection                              → 405                              (the framework's, three verbs)
POST   connection, kd_test_… key               → 502 DEPENDENCY_FAILED, retryable  (no database behind the placeholder)
GET    connection, kd_test_… key, no domain    → 502 DEPENDENCY_FAILED, retryable  (authenticated first, as designed)
DELETE connection, kd_test_… key               → 502 DEPENDENCY_FAILED, retryable
```

The three verbs therefore refuse an unauthenticated caller identically, and a key that authenticates reaches a
database that is not there. Every branch behind that point — the install, the reuse, the revocation, the race, the
refusal and the chain — is proven in the gate against a PostgREST-shaped fixture, because a real database is not
available in this environment.

## Carried gaps (named rather than hidden)

1. **The plugin was written, reviewed and never executed.** There is no PHP interpreter in this environment, so no
   `php -l`, no WordPress load, no WooCommerce call. The gate checks the source for the rules above and for balanced
   delimiters, which cannot prove a file compiles; the first run of this package on a real WordPress site is the real
   syntax and behaviour test, and it is the next thing to do before publishing.
2. **The package is not published.** FEATURE_LIST `:315` requires the plugin package to be available for merchant
   stores at launch: zipping it, signing it and hosting it is a release step that belongs to the launch checklist, not
   to this STEP.
3. **A revoked or token-mismatched store cannot be repaired from the plugin.** Both are `409`s that say "contact
   support", because `0035` freezes a revoked row and forbids resealing under the same key version. A support tool that
   revokes and re-creates a row deliberately is a screen this range does not own.
4. **A token is compared by its last four characters.** That is the only part `0035` lets a screen see, so a store that
   presents a different token with the same tail is answered `reused` — a 1-in-65 536 coincidence, and the alternative
   is reading the ciphertext on every handshake, which this surface deliberately never does.
5. **No UI on the platform side.** §20's credential screen (STEP 200) is where a merchant creates the key this plugin
   pastes; no screen here lists a merchant's connections, which is a merchant-facing surface this range does not own.
6. **Nothing yet reads a connection.** Payments, refunds and the outbound calls the platform makes *to* a store are
   STEP 209's and 210's: this STEP is the handshake and the row, and no other surface in the tree references
   `store_connections` yet.
7. **`plugins/` is outside the structure gate's roots.** The PHP package is reviewed by `check:woocommerce` instead of
   by the TypeScript convention, and adding a source root would move three checkpoints several handoffs quote; the
   choice is recorded here rather than made silently.
