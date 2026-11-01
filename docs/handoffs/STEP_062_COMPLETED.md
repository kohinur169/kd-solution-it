// path: docs/handoffs/STEP_062_COMPLETED.md
# STEP 062 - Rate limit service with per user, per IP and per endpoint buckets: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_061_COMPLETED.md`
(commit `5630f32`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 810, the ninth STEP of the security block 056-067: a rate limit
service with per user, per IP and per endpoint buckets. `docs/final/FEATURE_LIST.md` line 220 requires
every API call to be rate limited and audited, and line 242 puts IP based rate limiting on the
authentication endpoints.

## What already existed

STEP 045 had already built the storage half, and this STEP builds on it rather than beside it:

- `migrations/0092_rate_limit_windows.sql` - `public.rate_limit_windows`, one row per
  `(scope, key_hash)`, and `public.consume_rate_limit(scope, key_hash, limit, window_seconds, now)`,
  which increments, decides and answers in one statement under a row lock;
- `lib/auth/rate-limit.ts` - the address rule for the fifteen authentication endpoints.

## What was built

One new module, `lib/security/rate-limit.ts`, and no new dependency, no migration and no new table.

- **Three buckets, one decision.** A request is counted three times and refused when any bucket is full:

  | bucket | subject | scope | what it catches |
  | --- | --- | --- | --- |
  | `ip` | the address | `ip_<class>` | one machine walking every route of a class |
  | `user` | the signed-in account | `user_<class>` | one account spread over many addresses |
  | `route` | the address on one route | `route_<class>` | one endpoint being hammered |

- **Six classes**, each a frozen triple of limits:

  | class | ip | user | route | window |
  | --- | --- | --- | --- | --- |
  | `public_api` | 300 | 1 000 | 60 | 60 s |
  | `webhook` | 1 200 | none | 600 | 60 s |
  | `office_read` | 240 | 300 | 120 | 60 s |
  | `office_write` | 60 | 90 | 30 | 60 s |
  | `export` | 10 | 10 | 5 | 300 s |
  | `authenticated` | 600 | 600 | 240 | 60 s |

  In every class the route limit is below the class limit, so the bucket that trips first on a hammered
  endpoint is the one that names that endpoint. `webhook` has no account bucket because a provider
  webhook arrives before a session exists; every other class has all three.

- **Classification** is by path and method, with the look-alikes handled: `/api/public/...` is
  `public_api` while `/api/publicity` is `authenticated`, `/api/webhooks/...` is `webhook` while
  `/api/webhooksomething` is not, anything ending in `/export` is `export` before it is `office`, and a
  `GET`/`HEAD`/`OPTIONS` under `/api/office/` is a read while everything else is a write.

- **The counter is not duplicated.** `consume_rate_limit` already takes an opaque `(scope, key_hash)`,
  so a bucket is a scope plus a key hash and no migration was needed. The gate asserts that exactly one
  migration in the repository defines that function - the property that makes a second counter
  impossible to add quietly - and that `lib/auth/rate-limit.ts` calls the same name.

- **One spelling of an address.** `net.isIP` decides whether a value is an address at all and the URL
  parser produces the lower case compressed form, so `2001:0db8:0000::1` and `2001:db8::1` share one
  bucket. The key stored is the hex SHA-256 of the subject, never the address.

- **Never reads a request.** The module is handed the route, method, address and account. Which hop of
  `x-forwarded-for` is real stays a single decision in `lib/auth/client-address.ts`; the gate asserts the
  new module contains no forwarding header name and no `headers.get`, and imports nothing from
  `lib/auth` (there is no cycle: auth imports security).

- **Failure to count is a refusal.** No address or a value that is not an address is
  `SERVICE_UNAVAILABLE`; an unreadable counter answer, or one that reports more room than the policy, is
  `DEPENDENCY_FAILED`. Ten malformed answers are in the corpus and every one is refused rather than read
  hopefully.

- **The refusal** is `429 RATE_LIMITED` with `retry-after` (the longest wait among the refusing buckets),
  built by `rateLimited()` from the error catalog. The audit entry `security.rate_limited` names the
  route, class, refused buckets, their scopes and key hashes, and is written **once per window** - the
  `first_refusal` answer of `0092` - so an attack leaves one line, not a copy of itself.

- **Two routes are never refused.** `/api/health` and `/api/jobs/health` are exempt by exact path: a
  liveness probe answered with `429` reports the platform as down, and the monitor would be right.
  `/api/health/deep` is not exempt, so a future route cannot inherit the exemption by sitting under it.

## What was deliberately not connected

No route calls the new limiter yet, and the STEP says so plainly: the fifteen `/api/auth/*` routes are
limited by `lib/auth/rate-limit.ts` (STEP 045), the two probes are exempt, and the five `/api/office/*`
routes belong to STEPs 068-078, which own those handlers. Wiring them here would have meant editing files
another STEP owns. What this STEP leaves:

- `enforceRouteRateLimit(request, dependencies)` is the one call: count, audit a first refusal, refuse or
  pass, and `rateLimitHeaders(outcome)` gives a route its three `ratelimit-*` headers;
- the gate enumerates every `app/api/**/route.ts` in the tree (22 of them), derives the URL path, and
  asserts each is either counted by a class or is one of the two exempt probes - so a route added
  tomorrow cannot be silently unlimited, and wiring it is one line rather than a decision.

No i18n string was added, and that is deliberate: the refusal sentence a person reads is already
`errors.rateLimited`, and the screens' own wording with a countdown is `rateLimit.wait` /
`rateLimit.waitWithMinutes`. Adding a fourth, unused sentence for the account bucket would be text no
screen renders; the handoff records that a screen which wants to say "this account" rather than "this
network" needs one new key when it exists.

## Security proof

`node lib/security/verify.ts` - **970 checks** (604 before this STEP; +366), still 200 code point name
ceiling, 15 allowed tags.

- Policy table: six classes, frozen at every level (table, class, bucket), positive integer limits, and
  windows inside the `rate_limit_windows` check.
- Eighteen scopes, each against the `^[a-z][a-z0-9_]{1,39}$` pattern of `0092`, each unique, each naming
  its own dimension.
- Addresses: the two spellings of an IPv6 address are one key; a host name, a port, a zone index, a
  forwarding header and a padded octet are all refused.
- Routes: trailing slash, doubled slash, query, fragment, look-alike prefixes, method case, and the
  exemption that does not extend to a sub path.
- Buckets: three for an office write, two for a webhook, shared address key across a class, separate
  route and account keys, and the two wiring mistakes that throw (`INTERNAL_ERROR` for an account-less
  request on a class that needs one and for an id that is not a uuid).
- Decision: an in-memory counter that mirrors `consume_rate_limit` is driven to the exact boundary - the
  request that reaches the limit is allowed, the next is refused with `retry-after` equal to the rest of
  the window - and the audit is written once for the first refusal and not for the second. The
  combination rules are proved separately: longest wait, smallest remaining, and a refusal that still
  spent the other buckets.
- Reports: the audit entry's action matches the dotted-name pattern, its payload fits the 8 192 byte
  column and carries key hashes rather than addresses; the three headers are exactly
  `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, none of them a security header of
  STEP 060, and the reset is checked at three instants where a wrong formula gives a different number.

Fourteen mutation controls, all caught: a route limit above its class limit, the exemption ignored, a
non-address accepted, the account key built from the address, the shortest wait reported, the largest
remaining reported, every refusal audited, a counter allowed to report more room than the limit, the
wrong refusal code, the reset counted the wrong way, a day-long window stretched, the trailing slash
kept, a webhook given an account bucket, and the counter called under a second name. One control is
worth recording: the reset formula survived its first mutant because the fixed instant used for the other
checks made the right and the wrong formula agree (both answer 30 at thirty seconds past the minute); it
is caught only by checking three instants, which is what the corpus now does.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 970 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **172** sources (171 before);
config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell 237,
jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/rate-limit.ts`, `docs/planning/STEP_062_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_062_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "How often a request may ask",
and a row in the module table).
No migration, no `package.json` change, no new dependency, no new root file, no test file, no i18n string.

## Package requests

Unchanged from STEP 061: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule.

## Next

STEP 063 of `docs/final/STEP_PLAN_250.md`, the audit log writer with hash chaining, which is the next
entry of the security block. Nothing in this STEP is pending. Two seams for later STEPs: the office STEPs
068-078 wire `enforceRouteRateLimit` into their handlers (one line each, the classification already
covers their paths), and a STEP that needs a seventh class adds it to `RATE_LIMIT_CLASSES` and its policy
- the gate derives the scopes from the table, so half an edit fails.
