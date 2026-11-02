// path: docs/handoffs/STEP_067_COMPLETED.md
# STEP 067 - Velocity counter service for card tokens and IP addresses: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_066_COMPLETED.md`
(commit `5bf2c3b`). This STEP is commit `76e32d6`.

## What was asked

`docs/final/STEP_PLAN_250.md` line 869: a velocity counter service for card tokens and IP addresses, the
last STEP of the security block 056-067. `docs/final/FEATURE_LIST.md` line 197 requires card and IP
velocity limits with defaults in config; line 196 makes a blacklist entry a card token or a provider
fingerprint, which is the value a card counter is keyed on. The two velocity signals of STEP 066 already
exist and consume a reading through `FraudSignalLookups.readVelocity`; nothing produced one.

## What already existed

- `migrations/0056_velocity_counters.sql` (STEP 030) - the table: one row per card fingerprint or address
  and window, `window_seconds between 1 and 2592000`, `limit_value >= 1`, `exceeded_at is null or
  (hit_count >= limit_value and exceeded_at >= window_start)`, `window_start <= created_at`, two partial
  unique keys over `(subject, window_start, window_seconds)`, a guard trigger that freezes the subject,
  the window and the limit, counts up only, writes the breach once, moves `last_hit_at` forward only and
  refuses a delete, RLS default-deny, and `company_id` forced to null.
- `migrations/0074_platform_and_audit_policies.sql` - the two policies of that table.
- `migrations/0092_rate_limit_windows.sql` (STEP 055) - one function, one statement, an answer describing
  the state after the attempt: the shape to copy.
- `lib/security/rate-limit.ts` (STEP 062) - `canonicalRateLimitAddress`, the one spelling of an address.
- `lib/security/fraud.ts` (STEP 066) - `FraudSignalLookups.readVelocity`, the contract to fill.
- `lib/security/audit.ts` (STEP 063) - the entry shape and `auditEntryProblem`.

The table could be read and written, but not moved by one statement, so a service would have lost
increments under exactly the burst the limit exists for; and no caller retired a window.

## What was built

### `migrations/0093_velocity_counter_consume.sql` and its rollback

`public.consume_velocity(p_subject, p_card_fingerprint, p_ip_address, p_limit, p_window_seconds, p_now)`
returns one row of six values: `counter_hits`, `counter_limit`, `counter_window_start`,
`counter_window_seconds`, `counter_exceeded`, `counter_first_breach`.

- It validates the subject (`card` or `ip`), the field that must carry it and the field that must not
  (so a card counter can never silently drop an address), the limit, the window and the instant.
- It aligns the window to the epoch: `floor(epoch / window_seconds) * window_seconds`, so two attempts in
  one window name one row and a lapsed window is a new row.
- It moves the counter with `insert ... on conflict ... do update`. A table with two partial unique keys
  has no single conflict target, so the function branches once and each branch infers its own index
  (`where card_fingerprint is not null and deleted_at is null` / the same over `ip_address`).
- The update touches only `hit_count`, `last_hit_at` and `exceeded_at`, because `0056`'s guard trigger
  refuses anything else; the breach is written on the hit that reaches the limit and never rewritten.
- `created_at` is the caller's instant, not the transaction's `now()`, so `velocity_counters_start_check`
  (`window_start <= created_at`) cannot fail on a clock a second ahead.
- `counter_exceeded` is `hits >= limit` (the comparison `0056` records) and `counter_first_breach` is
  `hits = limit`, which happens exactly once per window because the count rises by one from one.
- One function, `set search_path = ''`, every object schema qualified, no `delete from`, one transaction.

The rollback drops the function and leaves the rows: they are the record of a decision that was made, and
`0056` retires a window by a sweep, never by a rollback.

### `lib/security/velocity.ts`

- `consumeVelocity` - one hit, one reading. The subject is canonicalised first (the token becomes the 64
  hex fingerprint `0055` blacklists, or an existing fingerprint is accepted unchanged; an address goes
  through STEP 062's `canonicalRateLimitAddress`), the policy is validated against the bounds of `0056`,
  the clock is read once, and the six arguments go to the function. The answer is checked field by field,
  including that its window is the window that was asked about, and `firstBreach`/`exceeded` are checked
  against the count they claim to describe.
- `createVelocityReader` - the exact contract STEP 066 consumes: one call per attempt, answering
  `{ hits, limit }` and nothing else, writing the audit entry of the first breach when a trail is given.
  A trail that fails never fails the payment; the counter already moved.
- `velocityAuditEntry` - `security.velocity_limited`, on the platform chain (`companyId: null`, as `0056`
  forces), naming the subject kind, the fingerprint for a card, the count, the limit, the window and the
  wait. An address is not repeated in the payload: it travels in the entry's own field.
- `sweepVelocityWindows` - the retention. The migration gate forbids a forward file from deleting a row,
  so the sweep is a client call with a cutoff, and it refuses a retention shorter than the widest window
  in force: deleting a live counter frees its key for a fresh count of zero, which is the limit bypassed
  and silent.
- `VELOCITY_DEFAULT_POLICY` - five card attempts and twenty address attempts in an hour, until an
  operator's setting replaces them; the policy is a parameter so the setting can travel.
- Fail closed: a failed call, an answer in any other shape and a clock that cannot place a window are
  `DEPENDENCY_FAILED` or `INTERNAL_ERROR`, never "the first attempt of a fresh window".

## The two things the corpus changed

The first draft compared a card token with its own `trim()` after testing it against the visible-ASCII
pattern, and no case could reach the second guard: a token with a space is refused by the pattern first.
The redundant comparison is gone, which is why the token ceiling and the pattern are the only two rules
there. The same pass added a direct check of the wait past the end of a window, because the one-second
floor was otherwise reachable only through a row the service rejects.

## What was deliberately not connected

No route: the payment core of STEPs 127-146 passes `createVelocityReader` to `fraudDecide`. No cron entry:
`lib/jobs/` is STEP 011's, and the retention job calls `sweepVelocityWindows` - a schedule written here
would be a second place deciding when a window may be removed. No i18n string: nothing renders a count or
a wait. `package.json` untouched.

## Database proof - the PGlite replay

`0093` was run against a real Postgres (PGlite 0.5.14, wasm PG 18) with the real `0001` (the two helper
functions and `companies` as the foreign-key target), the real `0056` (the table, both indexes, the guard
trigger, the metadata trigger and the policies) and the real `0093`: **54 checks**, including

- the window aligns to the epoch, and the last millisecond of a window is still in it;
- the count rises one per hit, five hits are one row, and the count keeps rising past the limit;
- the hit that reaches the limit is the only one that answers `first_breach`, and `exceeded_at` is written
  at that instant and never rewritten;
- a lapsed window and a different window length are new rows, one card and one address are independent,
  and a limit changed inside a window does not rewrite it (the row keeps its limit, the count keeps
  counting);
- two spellings of one IPv6 address are one row (`2001:0db8:0000:0000:0000:0000:0000:0001` is
  `2001:db8::1`);
- thirteen refusals: a subject that is not card or ip, a limit of zero, a negative limit, a window of
  zero, a window of thirty days plus a second, a card with no fingerprint, an upper case fingerprint, a
  sixty-three character fingerprint, a card carrying an address, an address with no address, an address
  carrying a card, a string that is not an address, and a hit with no instant;
- the guard refuses a counter that counts down, a cleared breach, and an update that puts a window after
  the row that records it;
- the rollback removes the function, leaves the rows, and the forward file applies again afterwards;
- **three negative controls**: `first_breach` loosened to `>=` reports a breach on every hit past the
  limit; a breach written one hit late (`hit_count >= limit` instead of `+ 1 >= limit`); and a card
  counter that silently drops an address - all three are caught by the checks above and restored.

**16 end-to-end checks** then ran `lib/security/velocity.ts` itself against that database through an RPC
client that answers JSON the way PostgREST does: the six argument names and the column each lands in, six
hits of one card counting 1 to 6 with one first breach, the wait to the end of the hour, a second window
starting at one, two spellings of one address counting the same counter, one audit entry for six attempts
in the window the real function reported, and an unreachable counter refused as `DEPENDENCY_FAILED`.

## Behaviour proof

| behaviour | exercised by | observed result |
| --- | --- | --- |
| a card token is counted, and the token is not what is stored | one token hit six times | hits 1 to 6, one row, keyed on the 64 hex fingerprint, `p_card_fingerprint` asserted in the arguments |
| the limit bites at the limit and not before | five hits against a card limit of five | `exceeded` false for 1 to 4, true from 5, `firstBreach` true only on 5 |
| a changed limit does not rewrite a window | a policy of nine on the fourth hit | the reading reports 5, the row's limit, and the count keeps counting |
| a lapsed window starts again | the same card an hour later | a second window, hits 1 |
| an address is one spelling | an IPv4 address, and two spellings of one IPv6 address | one counter for the two spellings; the row and the argument carry `2001:db8::1` |
| a card number is not hashable | three card numbers, and six more malformed tokens | `INTERNAL_ERROR` with `subject_invalid`, before any hash is computed |
| the database cannot answer | a client that throws, and twenty-three answers in the wrong shape | `DEPENDENCY_FAILED` with `response_invalid`, never a fresh window |
| the breach is audited once | six attempts with a trail attached | one `security.velocity_limited` entry, valid against `auditEntryProblem`, on the platform chain |
| an audit outage is not a payment failure | a trail that throws | the reading still stands |
| the sweep never deletes a live window | retention below the widest window in force | `INTERNAL_ERROR` with `retention_invalid` |

UI: not applicable, nothing renders a count in this STEP. API: not applicable, no route exists; the
service's success, refusal and dependency-failure paths are exercised directly. Money: nothing moves here -
this STEP counts attempts and answers a decision maker.

## Security proof

`node lib/security/verify.ts` - **2376 checks** (2042 before this STEP; +334), still 200 code point name
ceiling, 15 allowed tags. `checkVelocityVocabulary`, `checkVelocityConsumption`, `checkVelocityAudit`,
`checkVelocitySweep` and `checkVelocityWiring`:

- Vocabulary: the two subjects, the rule, the audit action against `AUDIT_ACTION_PATTERN` and its ceiling,
  the function and table names, the five problems, the frozen lists, the defaults of section 18, the
  retention equal to the widest window, and the bounds compared with `0056`'s own text.
- The subject: a deterministic 64 hex fingerprint, ten refused tokens (three of them card numbers), an
  existing fingerprint accepted unchanged, a token and its fingerprint naming the same card, an address,
  two spellings of one IPv6 address, an unknown kind and a string that is not an address.
- Consumption: the six arguments `0093` declares, asserted as one object; a reading of exactly nine
  fields; five hits to a breach and two past it; the frozen limit; a second window and a second subject;
  seven invalid policies and a policy with no rule for the subject; five invalid clocks; a failing client;
  and twenty-three answers in the wrong shape, every one `DEPENDENCY_FAILED` with `response_invalid` -
  including a window that is not the one asked about, a verdict the count does not support, and a
  `Date` where the REST client would answer an ISO string.
- Audit: one entry per window, its payload, the platform chain, the entity pair, the address in the
  entry's own field and not in the payload, the audit module's own `auditEntryProblem`, the factory
  returning null for every other hit, and a trail that fails without failing the payment.
- Sweep: the cutoff to the millisecond, the retention floor against the widest window in force, five
  invalid retentions, a failing store, three impossible counts and an invalid clock.
- Wiring: STEP 062's address rule, STEP 066's contract imported and the arrow not reversed, no log, no
  environment read, no request, no `any`, no SQL of its own; the migration's two branches, both conflict
  targets and their predicates, the two guards that write the breach, the fact that it rewrites neither
  the limit nor the window nor `deleted_at`, that a forward file deletes no row, and that the rollback
  removes the function and not the rows; and exactly one migration in the tree defines the counter and
  exactly one module calls it.

**Twenty-eight mutation controls, all caught:** a breach test of `>` instead of `>=`; a first breach
loosened to `<=`; the answer's window no longer compared with the window asked about; its length
unchecked; its limit unbounded; a count of zero accepted; a wait allowed to be zero; a card number hashed
instead of refused; the token ceiling removed; a token with a space hashed; an existing fingerprint hashed
again; an address not canonicalised; a policy limit of zero accepted; the policy window ceiling removed; a
clock not validated; a failed call that is not an `AppError`; every hit audited rather than the first
breach; an entry that claims a company; an address breach carrying a fingerprint; a retention shorter than
the window; a cutoff that ignores the retention; a negative sweep count accepted; a reader answering more
than the contract; an instant that is not the one the window was built from; an address hit sending a
fingerprint; an audit outage failing the payment; and two mutants of the migration (a first breach on
every hit, and a rewritten breach instant).

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 2376 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |
| `node migrations/verify.ts` | 2766 checks, 93 migrations, 75 tables |

`npm run verify` components: structure 17 directories, 14 root files, **177** sources (176 before);
config 10 sections / 28 values; i18n 294 messages / 14 placeholders; logger 117; errors 202 checks / 15
codes; lint 77; shell 237; jobs 110; migrations 2766 checks / **93** migrations / 75 tables (2746 / 92
before).

## Files

New: `migrations/0093_velocity_counter_consume.sql`,
`migrations/0093_velocity_counter_consume.down.sql`, `lib/security/velocity.ts`,
`docs/planning/STEP_067_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_067_COMPLETED.md`.

Edited: `lib/security/verify.ts` (five new blocks, +334 checks), `lib/security/README.md` (a new section,
"How often one card and one address may pay", a row in the module table, and two entries under "What is
deliberately not here").

No `package.json` change, no new dependency, no new root file, no test file, no i18n string, no new
directory. `migrations/README.md` still has no row for `0091`-`0093`; that table was last filled by the
database STEPs and writing it here would be a second owner of it.

## Rollback

`migrations/0093_velocity_counter_consume.down.sql` drops `public.consume_velocity` and nothing else. The
table, its indexes, its guard trigger and its policies are `0056`'s, and its rows are the record of the
attempts that were counted - the sweep retires them by age, never a rollback. Re-applying `0093` after the
rollback was part of the replay.

## Package requests

Unchanged from STEP 066: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule. New, for the STEP that owns `config/`: the velocity defaults
(`VELOCITY_DEFAULT_POLICY`) and the retention (`VELOCITY_RETENTION_SECONDS`) belong in `config/` rather
than in the module, because section 18 says the defaults are config.

## Next

STEP 068 of `docs/final/STEP_PLAN_250.md`, the first STEP after the security block. Nothing in this STEP is
pending. The seam for the payment core of 127-146: build the lookups object with
`createVelocityReader({ rest, policy, now, audit, auditContext })` for `readVelocity` and pass it to
`fraudDecide`; schedule `sweepVelocityWindows` from the retention job in `lib/jobs/`, with a retention at
least as wide as the widest window in force.
