// path: docs/planning/STEP_055_SUBSTEP_BREAKDOWN.md
<!-- STEP 055 - Sub-step breakdown -->

# STEP 055 - Sub-step breakdown

STEP 055: **IP based rate limiting on authentication endpoints**
(`docs/final/STEP_PLAN_250.md` line 726), from `docs/final/FEATURE_LIST.md` section 22 line 242
("IP based rate limiting applies on authentication endpoints") and line 238 ("Failed attempt
counters and lock state are stored in the database and survive server restarts").

## What already exists, and what is missing

- `readClientAddress` (STEP 0xx) already turns `x-forwarded-for` / `x-real-ip` into one validated
  address, and refuses to invent one.
- `ERROR_CODES.RATE_LIMITED` is `429` with `retryable: true`, `rateLimited(seconds)` builds it, and
  `respond.ts` already emits the `retry-after` header. `RATE_LIMITED` is inside `TRANSPORT_CODES`,
  so every anonymous surface may answer it today - the disclosure table needs no change.
- `0011_login_attempts` records *what happened on an attempt*, and its comment says in its own words
  that the IP limit is a query over it. That is true for sign in and the second factor and false for
  the other twelve endpoints, and it has no counter that is safe under a burst.
- Nothing in the platform increments a per-address counter, and nothing survives a restart in the way
  section 22 requires. An in-memory limiter would pass a single-process smoke test and fail exactly
  when it matters: on a second instance, after a deploy, and during the attack.

## The decisions this STEP makes

1. **The counter is a table and the increment is one statement.** `public.rate_limit_windows` holds
   one row per `(scope, address)` and `public.consume_rate_limit` moves it with a single
   `insert ... on conflict ... do update ... where hits < limit`, so two requests in the same
   millisecond cannot both read "9 hits" and both write "10". An update built from a value the
   service read earlier would lose increments under exactly the burst the limit exists for.
2. **A fixed window, reset in place.** The row carries `window_started_at`; when the window lapses the
   same statement rewrites the row to `hits = 1` and a new start. One row per address per scope, so
   the table grows with addresses rather than with requests, and there is no per-request row to
   retire.
3. **The address never reaches the table.** The key is `sha256(canonical address)` in hex - the same
   shape `login_attempts.email_hash` uses for the same reason. The address itself still reaches the
   audit entry and the log, where an operator needs it, and the table stays a set of counters.
4. **One address, one form.** An IPv6 address has many spellings and each one would be a fresh
   bucket, so the address is canonicalised (`2001:0db8::0001` and `2001:db8::1` are one key) before it
   is hashed.
5. **No address, no request.** Section 22 line 238 says the counters are per address; a request that
   reaches the origin without one cannot be counted. It answers `SERVICE_UNAVAILABLE` rather than
   being let through unlimited - the one behaviour a limiter must never have. Every limited endpoint
   already needs the database, so failing closed costs nothing that was still working.
6. **Fourteen scopes, one per auth route.** The policy is a frozen table in `lib/auth/rate-limit.ts`,
   beside `STEP_UP_WINDOW_MS` and the lock thresholds, and `checkRateLimit()` fails when any route
   under `app/api/auth/` does not name one. A new auth endpoint therefore cannot ship unlimited.
7. **A refusal is audited once per window.** `auth.rate_limited` is written when the row's
   `refused_at` was null and the function set it, so the trail says "this address was limited on this
   endpoint at this instant" without turning an attack into an audit flood. The counter itself is
   still incremented only on allowed requests, so the ceiling is exact.

## Sub-step 1 - Read the contract

`FEATURE_LIST.md` section 22 lines 238-242, `0011_login_attempts.sql`, `lib/auth/client-address.ts`,
`lib/errors/{codes,app-error,respond}.ts`, `lib/auth/audit.ts` and `0075` (the RPC and function
conventions), the STEP 054 handoff's "Next", and the fourteen route files.

## Sub-step 2 - Owned paths

New: `migrations/0092_rate_limit_windows.sql` + `.down.sql`, `lib/auth/rate-limit.ts`,
`docs/planning/STEP_055_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_055_COMPLETED.md`.

Modified: the fourteen `app/api/auth/**/route.ts` files (one call each), `lib/auth/verify.ts`
(`checkRateLimit()`), `lib/auth/README.md`, `lib/i18n/strings/en.ts`, and the four client components
that already map a status to a sentence, so a `429` says something a person can act on.

## Sub-step 3 - Database: `0092_rate_limit_windows.sql`

`public.rate_limit_windows` (`scope`, `key_hash`, `window_started_at`, `window_seconds`, `hits`,
`refused_at`) with a unique constraint on `(scope, key_hash)`, the standard columns and checks, its
RLS default-deny policy, and `public.consume_rate_limit(scope, key_hash, limit, window_seconds, now)`
which answers `(allowed, remaining, retry_after_seconds, first_refusal)`. The rollback drops the
function and the table.

## Sub-step 4 - Core service `lib/auth/rate-limit.ts`

`RATE_LIMIT_SCOPES`, `RATE_LIMIT_POLICIES`, `rateLimitScopeForPath`, `canonicalClientAddress`,
`rateLimitKeyHash`, `consumeRateLimit` (the RPC and its answer) and `enforceRateLimit` (the one call a
route makes: read the address, consume, audit the first refusal, throw `rateLimited`).

## Sub-step 5 - Wiring

Fourteen routes, one call each, before the body is read and before the session is looked up.

## Sub-step 6 - UI

A `429` sentence with the `retry-after` seconds, in the four components that already map a status,
plus the sign in and sign up forms.

## Sub-step 7 - Security proof

`checkRateLimit()`: the policy covers every auth route and names it, the key is the hash of a
canonical address, a refusal is a `429` with `retry-after`, the audit entry is written once, the
migration's function is the only writer, and no route reaches its handler before the limit.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/auth/verify.ts`, `node lib/i18n/verify.ts`,
`npm run check:migrations`, `npm run verify`, a PGlite replay of `0092`, mutation controls, then one
commit `STEP 055: IP based rate limiting on authentication endpoints`, pushed to
`arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_055_COMPLETED.md`.
