# STEP 202 — API authentication, rate limiting and audit logging

Status: **complete**. Commit `STEP 202: API authentication, rate limiting and audit logging` (`1945f8b`), then this
handoff, on `arena/ca936761-kd-solution-it`, branched from STEP 201's `e3be04d`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **73 gate lines**, and this STEP's gate is `lib/api/verify-public-api.ts` at
**113 checks**, mutation-checked with **18 mutations: 16 red, one red only after the gate was strengthened, and one
shown to be equivalent**.

## STEP

From `docs/final/STEP_PLAN_250.md:2582`:

> **STEP 202: API authentication, rate limiting and audit logging**

FEATURE_LIST §20 (`:220`), the sentence this STEP owns: *"Every API call requires authentication and is rate limited
and audit logged."* The create, revoke and regenerate of credentials were STEPs 200 and 201; this is the surface
those credentials finally open.

This is the **public API**, not the dashboard's credential forms. It is the first surface in the product that a
server talks to with no cookie, no session and no browser, which is why §8's separation and §20's *"keys are never
displayed and never appear in logs, UI or error messages"* bind here more tightly than anywhere else: a key arriving
in a header is the one place a real key exists outside a merchant's own vault.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/public-fields.ts` | new | 106 | The surface's whole vocabulary: prefix and version, the key header, scheme and 128 ceiling, the four refusal rules, the two audit actions, the 60-second throttle and the three published limits |
| `lib/api/public-api.ts` | new | 378 | Authenticate → count → answer → record, framework-free; `presentedKeyOf`, `authenticateApiCall`, `handlePublicApiCall` |
| `lib/api/public-runtime.ts` | new | 23 | The production wiring: one REST client, one chain, one clock - and deliberately no encryption key |
| `app/api/public/v1/credential/route.ts` | new | 68 | `GET` - the call that says whether a key works, in the shape §20's masking allows |
| `lib/api/verify-public-api.ts` | new | 724 | The gate, 113 checks, over an in-memory PostgREST and the platform's real limiter |
| `package.json` | edited | +1 link | `check:public-api`, one link in the `verify` chain |
| `migrations/` | **untouched** | - | `0034` carries the credential and `0092` the counter |
| `lib/i18n/`, `lib/security/csrf.ts`, `lib/auth/verify.ts` | **untouched** | - | No new copy, no new browser file, no new CSRF-protected path |

## Why there is no migration, and no new limiter

Two tables already exist for exactly this: `0034`'s `merchant_api_credentials` (the `key_hash` column, its unique
index, `last_used_at` waiting unused since STEP 023) and `0092`'s `rate_limit_windows` with its
`consume_rate_limit` function. And `lib/security/rate-limit.ts` - built in the platform-hardening STEPs - already
carries a `public_api` class with all three of its buckets and already maps `/api/public/*` to it. Writing a second
limiter for the public API would have been two implementations of one sentence. The chain therefore still ends at
**0128 / 128 migrations / 99 tables**.

## Authentication, in one paragraph

**Shape first, then hash, then row, then merchant.** `presentedKeyOf` requires the `Authorization` header to be
`Bearer` (compared case-insensitively, because HTTP says so) and one token, and it bounds that token at 128 characters
*before* the key pattern runs - a megabyte of header should cost one comparison, not a regex over a megabyte. Only
then is the token hashed, with the same `hashOfPresentedKey` STEP 200 issues with, and read back through a query
scoped by `key_hash=eq.` - the read is the scope, so there is no window in which a valid hash could be compared
against another merchant's row. **Unknown and revoked are one answer**: the same code, the same
`api_key_invalid` rule and the same sentence, because a surface that distinguishes them is a surface an attacker can
use to discover that a guessed key once existed. The one refusal that is not about the key is
`account_unavailable`, for a key whose merchant row is gone - a caller who has done nothing wrong needs to know their
key is not the problem. `last_used_at` is written last, at most once per 60 seconds, under `version=eq.`, and a write
that lands nowhere does not fail the call.

## The pipeline, in one paragraph

**Count, then answer, then record - and never in the other order.** `handlePublicApiCall` authenticates, calls the
platform's own `enforceRouteRateLimit` with `userId: principal.companyId` - *the merchant, not the credential*, because
a merchant with ten keys is one caller and should not be able to multiply their budget by minting more - answers, and
records. A refused authentication writes one `api.auth_failed`; every answered call writes one `api.call` with its
method, route, status, mode, duration and the key's last four characters; a handler that throws has its status
recorded before the error propagates, so the chain holds the `429`s and `404`s that never became answers. Neither
entry carries the key, its hash, the query string, the body or any header but the address. A call answers `no-store`
with `x-api-version: v1` and the limiter's three `ratelimit-*` fields, and the company id travels in the body because
a store that pasted the wrong key finds out fastest by seeing that the id is not theirs.

## What the gate proves (6 sections, 113 checks)

| Section | What it pins |
| --- | --- |
| 1 | That this STEP added **no** migration, that the surface lives at `/api/public/v1`, and that it answers as `v1` |
| 2 | Nine malformed headers - absent, empty, spaces, no scheme, wrong scheme, scheme-only, token with a space, a token that is not a key, a token past the ceiling - each refused with `AUTHENTICATION_REQUIRED`, the right rule, a 401 and **no query**: "before the hash" is a measurement of the fixture's `select` count, not a claim; the scheme's case-insensitivity and a well-shaped key coming back unchanged |
| 3 | A live key's principal (id, merchant, name, mode, handle, last four), the throttle (first call writes, second inside the minute does not move the version, a call after 61 s does), a lost write not failing the call, and the two uniform refusals compared field by field |
| 4 | The pipeline: 200 with `no-store`, `x-api-version`, all three `ratelimit-*` headers, **three buckets all in the `public_api` class**, the route limit equal to `RATE_LIMIT_CLASS_POLICIES.public_api.route.limit` and to the number the API publishes (account and address ceilings too), the account bucket's key being identical for two credentials of one merchant, one `api.call` per call with every field it must hold and the key absent from it, the recorded status being the route's own 201 rather than a constant, a refused attempt writing `api.auth_failed` and **no** `api.call`, a full bucket answering `RATE_LIMITED`/429 with the limiter's own `security.rate_limited` entry beside the call entry, and a handler's 404 recorded before it propagates |
| 5 | The route: `GET` and no `POST`, through the pipeline and the runtime, `force-dynamic`, no `console`, no CSRF token and no cookie (a bearer key is not an ambient credential), no signing secret, and the answer carrying the last four and nothing else of the key; the pipeline's source discipline - shape check before pattern, pattern before hash, `hashOfPresentedKey(token)`, the active-row rule, the merchant read, the `version=eq.` guard, the merchant-keyed bucket |
| 6 | The words: every refusal rule a machine word, `api.call` literal, `api.auth_failed` fitting the chain's pattern, the fixture's keys being keys by the platform's own pattern, and the platform's hash being a plain SHA-256 of the key |

### The mutations

Eighteen, each restored immediately. Sixteen red:

1. the key pattern skipped, so any token is hashed
2. the length ceiling removed (caught only after the gate pinned the guard's *order* - see below)
3. unknown and revoked sharing one branch
4. a revoked row let through
5. the merchant read replaced by a synthesised row
6. the closed-merchant refusal disabled
7. the `last_used_at` throttle removed
8. the `version=eq.` guard removed from the last-used write
9. the account bucket keyed on the credential instead of the merchant
10. the answered call not recorded
11. the recorded status a constant instead of the answer's
12. the `api.auth_failed` entry removed
13. `cache-control` weakened to `public, max-age=60`
14. `x-api-version` answering `v0`
15. `enforceRouteRateLimit` bypassed
16. the route no longer going through the pipeline
17. the published route limit drifting from the limiter's
18. the recorded status hard-coded to 200 while the route answers 201

Two of these were **missed on the first pass** and the gate was strengthened rather than the mutation dropped:

- **The length ceiling** was redundant *in behaviour*: the anchored 64-hex pattern rejects every over-long token the
  gate could present, so removing the `token.length > API_KEY_MAXIMUM_LENGTH` half changed no answer. It is kept for
  cost - a huge header should not reach a regex - and the gate now pins its **order** relative to the pattern, which
  is the property that actually exists.
- **The recorded status** was equivalent while the only answers in the gate were 200s. The gate now walks a route
  that answers 201 and reads the chain entry, which turns the mutation red.

**One mutation is equivalent, and that is written down rather than hidden**: dropping `API_KEY_MAXIMUM_LENGTH` from
`public-fields.ts` changes nothing, because the gate's own checks derive every expectation from the pattern. The
constant is kept because it is the number a proxy's header limit is set from, and the mutation is recorded as
equivalent instead of being dressed up as a kill.

## Security

- **The key never leaves the request.** It is read, bounded, pattern-checked, hashed - and then only the hash, the
  handle and the last four exist anywhere: not in a view, not in a chain entry, not in an error, not in a log line.
  The gate searches the payloads it wrote for the key it issued.
- **The refusal is uniform.** Unknown, revoked and malformed-but-well-shaped keys are indistinguishable from outside;
  the only state-specific answer is a closed merchant, which the caller owns.
- **No ambient credential.** No cookie is read, no CSRF token is asked for, and the route is on no CSRF-protected
  path - correctly: a bearer key in a header cannot be attached by a hostile origin, which is the attack CSRF tokens
  exist for.
- **The counter is the platform's.** Keyed on the merchant, three buckets, spent through `0092`'s own function, and
  refused by the shared limiter so no route can forget it. The numbers published in the body are the numbers in
  `RATE_LIMIT_CLASS_POLICIES`, pinned by the gate.
- **The chain is written twice per refusal.** A failed attempt is evidence; a rate-limit refusal is a call that
  happened. Both are recorded before the caller learns anything.
- **The pipeline cannot be bypassed silently.** Its source discipline is in the gate - shape before hash, the
  version guard, the merchant-keyed bucket - so a later STEP that reorders those steps in passing fails a check.
- **A new credential is still never revealed.** Nothing in this STEP returns key material; the answer masks it, as
  §20 requires and as STEPs 200 and 201 already did.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean
npm run check:public-api          113 checks
npm run verify                    exit 0, 73 gate lines
node lib/api/verify-credentials.ts   225 checks (unchanged)
node lib/api/verify-credential-rotation.ts  190 checks (unchanged)
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3218 messages, 342 placeholders (unchanged: no new copy)
node lib/auth/verify.ts           59 files / 90 call sites (one pre-existing failure, unchanged)
node scripts/verify-structure.mjs 772 source files (five new)
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3404 with the placeholder environment STEP 199 recorded (plus `SUPABASE_SERVICE_ROLE_KEY`, which
production boot requires).

| Request | Answer |
| --- | --- |
| `GET /api/public/v1/credential` with no header | `401 {"code":"AUTHENTICATION_REQUIRED"}` |
| the same with `Authorization: Basic abc` | the same `401`, the same code |
| the same with a well-formed `kd_test_...` key | `502 {"code":"DEPENDENCY_FAILED"}` - the placeholder Supabase host refuses the read, which is the honest answer: the key got as far as the scoped query |
| `POST /api/public/v1/credential` | `405` |
| `GET /` | `200` |
| `next build` | `/api/public/v1/credential/route` in `app-paths-manifest.json` |

A full authenticated call cannot be walked here - there is no Supabase project, so no credential row can exist - and
is exercised end to end against the gate's fixture instead. `.env.local` was deleted again (checked: absent), and the
server was killed by pid.

## Carried gaps (named rather than hidden)

1. **The `401` body is dashboard copy.** `AUTHENTICATION_REQUIRED` renders
   `errors.authenticationRequired` - "Sign in to continue." - which is the right sentence for a browser and the wrong
   one for a server holding a key. The envelope's message comes from the error code in `lib/errors/respond.ts`, so a
   public-API-specific sentence means a code or a per-surface message table, both shared files outside this STEP's
   ownership. Named, not faked.
2. **A key still cannot be obtained.** STEP 200's gap 1 stands: §20 says a full key is never displayed, so a merchant
   can create, rotate and revoke keys but has never held a usable one. This surface is the first that would *use* one,
   which makes the gap sharper - the resolution options are in `STEP_200_COMPLETED.md`, gap 1.
3. **The surface answers one call.** `GET /api/public/v1/credential` is the only public route: it exists because
   without it the first thing every integration does is create a payment to see whether a key works. Payments and the
   rest of the public API are later STEPs; the pipeline is written so each of them is one handler function.
4. **No CORS answer.** A browser calling this surface cross-origin gets no `access-control-allow-origin`, because the
   surface is for servers. If a merchant wants to call it from a storefront, the allowed origin has to come from a
   policy decision and a per-merchant allowlist, neither of which exists yet.
5. **Rate-limit windows need the job that sweeps them.** `0092`'s rows accumulate; the platform's limiter is correct
   per window, but nothing here prunes old rows - the same carried gap the limiter's own STEP recorded.
6. **`last_used_at` is minute-accurate, and last-write-wins.** Two calls inside one window report one write, and the
   write is not retried if it loses its version race. That is deliberate for a column a merchant reads as "in use",
   but it means the column is not an audit trail - the chain is.
7. **An unknown merchant cannot revoke a leaked key.** A key whose merchant row is gone answers `account_unavailable`
   forever and `last_used_at` keeps not being written; only a support path could close it, and none exists yet.
