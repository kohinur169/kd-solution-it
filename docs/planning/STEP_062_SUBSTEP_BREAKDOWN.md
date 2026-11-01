// path: docs/planning/STEP_062_SUBSTEP_BREAKDOWN.md
# STEP 062 - Sub-step breakdown

STEP 062: **Rate limit service with per user, per IP and per endpoint buckets**
(`docs/final/STEP_PLAN_250.md` line 810), from `docs/final/FEATURE_LIST.md` line 220 ("Every API call
requires authentication and is rate limited and audit logged") and line 242 ("IP based rate limiting
applies on authentication endpoints"), inside the security block 056-067.

## What already exists, and what is missing

STEP 045 (authentication) built the *storage* half already, and it is not something to build twice:

- `public.rate_limit_windows` (`0092`) - one row per `(scope, key_hash)`, with a scope pattern of
  `^[a-z][a-z0-9_]{1,39}$`, a key of 64 hex characters, and a window between 1 and 86 400 seconds;
- `public.consume_rate_limit(scope, key_hash, limit, window_seconds, now)` - one statement that
  increments, decides, and answers `allowed`, `remaining`, `retry_after_seconds`, `first_refusal`;
- `lib/auth/rate-limit.ts` - the address rule for the fifteen authentication endpoints.

What is missing is everything that is not an authentication endpoint. Section 20 says every public API
call is rate limited; there is no limiter for the office routes, the webhooks, the exports or the
authenticated API at all, and the address-only rule of the authentication limiter is not enough for them:
one account spread over a thousand addresses is invisible to an address bucket.

## The decisions this STEP makes

1. **Three buckets, one decision.** A request is counted three times - the address across its class, the
   account across its class, and the address again on the one route - and refused when any of them is
   full. Each bucket is blind to something the others see: the account bucket to a machine walking every
   route, the address bucket to one account over many addresses, both to a single hammered endpoint.
2. **No second counter.** The table and the function already take an arbitrary `(scope, key_hash)`, so a
   bucket is a scope plus a key hash. The gate asserts that exactly one migration in the repository
   defines `consume_rate_limit`, which is the property that makes a second limiter impossible to add
   quietly.
3. **The scope names the dimension and the class**, `ip_office_write`, `user_public_api`,
   `route_export`: an operator reading a row sees what it counts, and two classes never spend each
   other's limit.
4. **The limits are code, not configuration.** A rate limit that can be raised on a running platform
   without a review is not a control. They live beside the other security constants, frozen, one class
   at a time.
5. **The route limit is always below the class limit.** A route is a fraction of a class, so the route
   bucket is the one that should trip first on a hammered endpoint - and the one whose name the refusal
   carries.
6. **The module never reads a request.** It is handed the route, the method, the address and the account.
   Which hop of `x-forwarded-for` is trusted is decided once, in `lib/auth/client-address.ts`; a second
   parser here would be a second answer to the same question. The gate asserts the module contains no
   forwarding header name and no `headers.get`.
7. **An address has one spelling.** `2001:0db8:0000::1` and `2001:db8::1` are one machine and must be one
   bucket. `net.isIP` decides whether a value is an address at all - the platform's answer, not a pattern
   of ours - and the URL parser produces the lower case compressed form the hash is taken of.
8. **A failure to count is a refusal.** No address, or a counter that cannot be read, is
   `SERVICE_UNAVAILABLE` or `DEPENDENCY_FAILED`: letting the request through when the counter is down is
   the one behaviour that turns an outage into permission.
9. **The audit entry is written once per window, not once per request.** `first_refusal` comes from the
   counter, so an address under attack leaves one line rather than a copy of the attack.
10. **Two routes are never refused.** A liveness probe answered with `429` reports the platform as down,
    and the monitor would be right. `/api/health` and `/api/jobs/health` are exempt by exact path, so a
    route added under them cannot inherit the exemption.

## Owned paths

New: `lib/security/rate-limit.ts`, `docs/planning/STEP_062_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_062_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`, so nothing outside it is touched - including `lib/auth/rate-limit.ts`,
which keeps its own address rule for the authentication endpoints and now provably writes the same table.
No migration is added and `package.json` is not edited.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_061_COMPLETED.md` (committed `5630f32`), `STEP_PLAN_250.md` line 810, feature list lines 215-245,
rule 11 and the ownership rules at line 45, `migrations/0092_rate_limit_windows.sql` and
`lib/auth/rate-limit.ts`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None, and deliberately so. `0092` already stores a counter keyed by an opaque `(scope, key_hash)` and
already moves it under a row lock in one statement; the three buckets are three scopes, not three tables.
A second migration would either duplicate that function or add a `dimension` column that the function
does not need. The gate compares the module's scope pattern, key pattern and window bounds with the
literals in `0092`, and asserts that the repository defines the counter exactly once.

## Sub-step 4 - The core logic

`lib/security/rate-limit.ts`:

- `RATE_LIMIT_BUCKET_DIMENSIONS` - `ip`, `user`, `route`, the three ways a request is counted;
- `RATE_LIMIT_CLASSES` and `RATE_LIMIT_CLASS_POLICIES` - six classes, three frozen limits each, with
  `webhook` the only class without an account bucket because a provider webhook arrives before a session;
- `RATE_LIMIT_EXEMPT_ROUTES` - the two liveness probes, by exact path;
- `normalizeRateLimitRoute`, `isRateLimitExemptRoute`, `isRateLimitReadMethod`, `rateLimitClassForRoute` -
  the classification, where `export` is tested before `office` and a `GET` is read while a `PATCH` writes;
- `rateLimitScopeFor`, `canonicalRateLimitAddress` - the scope naming and the one spelling of an address;
- `rateLimitBucketsFor` - the pure part: which buckets, with which scope, key, limit and window;
- `consumeRateLimitBuckets` - the counting, the strictest combination, and the refusal;
- `enforceRouteRateLimit` - the one call a route makes: count, audit a first refusal, refuse or pass;
- `rateLimitAuditEntry`, `rateLimitHeaders` - the audit entry and the three `ratelimit-*` headers.

## Sub-step 5 - Routes and jobs

There is no route to connect, and the STEP is honest about it: `lib/auth/rate-limit.ts` already limits
the fifteen authentication routes, and the remaining seven routes of the platform (`/api/health`,
`/api/jobs/health` and the five office endpoints) are not owned by a security STEP - the office routes
belong to STEPs 068-078, which will call `enforceRouteRateLimit` in their handlers. What this STEP leaves
behind is that the call is one line and that the classification already covers every route in the tree:
the gate enumerates `app/api/**/route.ts`, derives each URL path, and asserts that every one of them is
either counted by a class or is one of the two exempt probes, so a route added tomorrow cannot be
silently unlimited.

## Sub-step 6 - UI

Not applicable: the limiter runs before a handler, its refusal is `429 RATE_LIMITED` with `retry-after`,
and `respond.ts` already turns that into a response. No screen gains a field, a state or a string, so
there is nothing to check at either width. The sentence a person reads is `errors.rateLimited`, and the
screens' own wording for a wait is `rateLimit.wait` / `rateLimit.waitWithMinutes`, both of which already
exist; a screen that wants to say "this account" rather than "this network" needs one new key, which is
named in the handoff rather than added here unused.

## Sub-step 7 - Security proof

`checkRateLimitTable`, `checkRateLimitAddresses`, `checkRateLimitRoutes`, `checkRateLimitBuckets`,
`checkRateLimitReports` (sync) and `checkRateLimitDecision`, `checkRateLimitWiring` (async) in
`lib/security/verify.ts`: the frozen policy table and its invariants, the eighteen scopes against the
scope pattern of `0092`, the address canonicaliser, the route classification including the look-alike
prefixes, the bucket composition, a counter that mirrors `consume_rate_limit` in memory and is driven to
the exact limit boundary, the combination rules (once refused, longest wait, smallest remaining), the
ten malformed counter answers, the audit entry and its first-refusal-only rule, the three headers, and
the wiring (one counter definition, no forwarding header, no auth import, every route classified).

Fourteen mutation controls, all caught: a route limit above its class limit, the exemption ignored, a
non-address accepted, the account key built from the address, the shortest wait reported, the largest
remaining reported, every refusal audited, a counter allowed to report more room than the limit, the
wrong refusal code, the reset header counted the wrong way, a day-long window, the trailing slash kept,
a webhook with an account bucket, and the counter called under a second name.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 062: Rate limit service with per user, per IP and per endpoint buckets` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_062_COMPLETED.md`.
