// path: docs/handoffs/STEP_055_COMPLETED.md
# STEP 055 completed - IP based rate limiting on authentication endpoints

Branch `arena/1dc51ec3-kd-solution-it`, base `17d419a` (STEP 054).
Source: `docs/final/STEP_PLAN_250.md` line 726; `docs/final/FEATURE_LIST.md` section 22 line 242
("IP based rate limiting applies on authentication endpoints") and line 238 ("Failed attempt counters
and lock state are stored in the database and survive server restarts").

## What the STEP asks for

One sentence with two halves, and the second half is the one the platform did not have. The attempt
counters of line 238 exist since `0011`, and the lock since STEP 045, but both answer "what happened
to this account". Line 242 asks a different question - "how much is this *address* doing" - and
nothing answered it: an address could work through every account in the platform at whatever rate its
network allowed, and a counter in process memory would not have stopped it, because it would be per
instance and empty after a deploy.

## Sub-steps, in order

1. **Read the contract** - section 22 lines 238 and 242, `0011_login_attempts.sql` (whose comment says
   in its own words that the IP limit is a query over it), `client-address.ts`,
   `lib/errors/{codes,app-error,respond}.ts`, `audit.ts` and `0075` for the RPC and function
   conventions, the STEP 054 handoff's "Next", and the fourteen route files.
2. **Owned paths**, recorded in `docs/planning/STEP_055_SUBSTEP_BREAKDOWN.md` before any code.
3. **Schema** - `migrations/0092_rate_limit_windows.sql` and its rollback.
4. **Service** - `lib/auth/rate-limit.ts`, plus `lib/auth/refusal-message.ts` for the screen sentence.
5. **Wiring** - one call in each of the fourteen auth routes.
6. **Screens (where applicable)** - the `429` sentence with its wait, in the six components that can
   show one.
7. **Security proof** - `checkRateLimit()`, the mutation controls below, and a PGlite replay of `0092`.
8. **Gates, commit, push, handoff** - this document.

## Database - `0092_rate_limit_windows.sql`

`public.rate_limit_windows` is the counter: one row per `(scope, key_hash)`, carrying
`window_started_at`, `window_seconds`, `hits` and `refused_at`, with the standard columns, the RLS
default-deny policy and the `set_row_metadata` trigger of every other table.

| column | meaning |
| --- | --- |
| `scope` | the endpoint, as named in `lib/auth/rate-limit.ts` (`signin`, `session_rotate`, ...) |
| `key_hash` | SHA-256 of the canonical client address, hex - never the address |
| `window_started_at` | start of the fixed window this row is counting |
| `window_seconds` | the policy's window, so a row can be read without the code |
| `hits` | attempts counted in this window, never past the limit |
| `refused_at` | first refusal of the window, which is when the audit entry is written |

`public.consume_rate_limit(scope, key_hash, limit, window_seconds, now)` is the only writer. It is one
`insert ... on conflict on constraint rate_limit_windows_scope_key_unique do update ... where hits <
limit`, so the row lock Postgres takes is the serialisation point, and it answers
`(allowed, remaining, retry_after_seconds, first_refusal)`. A lapsed window is rewritten in place to
`hits = 1`, so a window costs no rows and the table grows with addresses rather than with requests.

### The bug the PGlite replay caught

The first version wrote `pg_catalog.greatest(...)` in two places, following the `search_path = ''`
convention of `0075`. `GREATEST` is not a function this schema can qualify - it is a grammar construct,
so `pg_catalog.greatest(integer, integer)` fails with SQLSTATE `42883` at execution time, which in
production would have been **every** refill and every refusal on every auth endpoint: not a wrong
limit, an outage. The PGlite replay failed on its third check; the two calls are now plain `greatest`
and `least`. Everything else in the function is `pg_catalog`-qualified as the convention requires.

## Service - `lib/auth/rate-limit.ts`

- `RATE_LIMIT_SCOPES` / `RATE_LIMIT_POLICIES` - fourteen scopes, one per auth route, frozen:

  | scope | limit | window |
  | --- | --- | --- |
  | `signin` | 30 | 5 min |
  | `signup` | 10 | 1 h |
  | `verify` | 30 | 10 min |
  | `two_factor_reset` | 5 | 1 h |
  | `two_factor_enroll` | 10 | 10 min |
  | `two_factor_confirm` | 30 | 10 min |
  | `two_factor_verify` | 30 | 5 min |
  | `backup_codes` | 10 | 10 min |
  | `device_enroll` | 20 | 10 min |
  | `device_confirm` | 30 | 10 min |
  | `session_rotate` | 120 | 5 min |
  | `session_reauth` | 30 | 5 min |
  | `session_list` | 120 | 5 min |
  | `session_revoke` | 30 | 5 min |

  The two ends are deliberate: rotation is the loosest because every open tab rotates, and the second
  factor reset is the tightest because each request is a message to the office. Every number is loose
  enough that a shared office address is not punished for being shared, which is why `signin` is 30
  and not 5 - the per-account lock of STEP 045 is what stops one account being guessed at.
- `RATE_LIMITED_PATHS` - the route-to-scope table the gate reads, so a new auth endpoint cannot ship
  unlimited.
- `canonicalClientAddress` - one address, one spelling: the URL parser compresses `2001:0db8::0001` to
  `2001:db8::1`, because otherwise one machine gets one bucket per spelling.
- `rateLimitKeyHash` - `sha256` hex of the canonical address.
- `consumeRateLimit` - the RPC, parsed with zod; an unreadable answer is `DEPENDENCY_FAILED`, not an
  allow.
- `enforceRateLimit` - the one call a route makes: read the address, consume, audit the first refusal,
  throw `rateLimited(retryAfterSeconds)`. No address is `SERVICE_UNAVAILABLE`; it never lets a request
  through uncounted.

## Wiring

All fourteen `app/api/auth/**/route.ts` files call the limiter as their **first** statement - before
the declared-length check, before `request.text()`, before `JSON.parse`, before the session lookup - so
a burst costs one RPC and never reaches the body or the database work behind it.

## Screens

`lib/auth/refusal-message.ts` (client safe, no Node import) turns the envelope's `retryAfterSeconds`
into one of two catalog sentences - minutes above a minute, seconds below - and a third sentence for
`SERVICE_UNAVAILABLE`. It is used by the sign in and sign up forms, the device confirmation form, the
owner's session list, the office session list and the office reset queue.

## Security proof - `checkRateLimit()`

188 new checks (auth gate 2007 -> 2195):

- the policy covers all fourteen routes, no scope exists without a route, every limit and window is in
  range, rotation carries the loosest limit and the reset request the tightest;
- each route calls the limiter exactly once, under its own scope, before the body is read or parsed;
- the address is canonicalised and hashed, two spellings share one key, the key is 64 hex and does not
  contain the address;
- the RPC receives the policy's limit and window, the injected clock and the hashed key; an answer the
  service cannot read is `DEPENDENCY_FAILED`;
- a refusal is `429` with the wait the counter answered, audited once, with the address on the entry
  and no account; an allowed request writes nothing; a later refusal in the same window is refused
  without a second entry; an address-less request is `SERVICE_UNAVAILABLE` and never reaches the
  counter;
- `0092` creates the table and the function, the increment is the upsert, the lapsed window is the
  `where` clause, the function pins `search_path`, is not `security definer`, contains no `delete
  from`, and the rollback drops the function and then the table;
- the two refusal sentences exist and the six components use them.

### Mutation controls (each breaks exactly one check, then is restored)

| control | failing check |
| --- | --- |
| remove the call from `signin` | "calls the limiter exactly once" + "counted under its own scope" |
| count `session/rotate` under `signin` | "is counted under its own scope" |
| drop the `firstRefusal` guard | the audit-entry checks (address, scope, actor) |

## PGlite replay - `0092`

The function is the crux, so it was run against a real Postgres (PGlite 0.5.14, wasm PG 18) with the
real `0092`, the real `uuid_generate_v7` and `set_row_metadata` from `0001`, and the real
`create table public.companies` block from `0001` as the foreign-key target: **35 checks**, including

- the ceiling is exact: three allowed, the fourth and fifth refused, and `hits` never moves past 3;
- the request that reaches the limit is allowed and the next one is refused (off-by-one in the right
  direction);
- the millisecond before the window ends is refused and the millisecond it ends is allowed, with the
  row rewritten in place and `refused_at` cleared;
- one row for one address and one scope, whatever the number of requests; scopes and addresses are
  independent; an upper-case scope, a non-hash key, a limit of zero and a window of zero or a day plus
  one are all refused;
- the rollback removes the table and the function, and the forward file applies again afterwards;
- **two negative controls**: an `<=` in the limit guard allows one request past the limit, and removing
  the `refused_at is null` guard makes every refusal look like the first - both are caught by the
  checks above, and both are restored.

## Gates

`npm run verify` exit **0**: structure 158 sources, config 10 sections/28 values, i18n 294 messages/14
placeholders, logger 117, errors 202/15 codes, lint 77, shell 235, jobs 110, migrations **2746 checks,
92 migrations, 75 tables**, `tsc --noEmit` clean, `next lint` clean, `next build` clean.
`node lib/auth/verify.ts` passes **2195 checks**. `node lib/i18n/verify.ts` passes 294 messages.

## Deliberately not done

- **No per-account IP exemption.** An office behind one address shares one window with a stranger
  behind the same address; the alternative (an allowlist) is a bypass, and the numbers are set so that
  sharing is not a problem in practice.
- **No retention job.** `rate_limit_windows` grows one row per address per endpoint, like
  `login_attempts`, and section 27's cleanup job is the one that will retire rows older than the
  configured window. A forward migration may not remove rows, so this file cannot.
- **No distributed "sliding log".** A fixed window allows at most `2 x limit` across a boundary; a
  sliding window would need a row per request, which is the growth this design exists to avoid. The
  boundary case is documented rather than hidden.
- **No limit on the office routes.** They are session-scoped and behind `requireFreshReauthentication`;
  section 22 line 242 names the authentication endpoints, and adding office limits would need a policy
  per role that this STEP has no measurement for.
- **No `ip_address` column.** The audit entry carries the address (`ipAddress`), the table carries the
  hash, and the attempt record is `0011`'s. Three copies of one address would be three retention
  problems.

## Package request (unchanged, still open)

`"check:auth": "node lib/auth/verify.ts"` inside `verify` before `check:lint`. `package.json` is not
edited by a STEP; this note is the request.

## Next

STEP 056 - input sanitizer library for text, rich text and URLs (`STEP_PLAN_250.md` line 740), the
first STEP of the application security core. The limiter's seam for later: section 20's public API
calls need the same counter keyed by credential rather than address, which `consume_rate_limit` already
supports through `key_hash`.
