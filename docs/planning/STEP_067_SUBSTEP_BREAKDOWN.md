// path: docs/planning/STEP_067_SUBSTEP_BREAKDOWN.md
# STEP 067 - Sub-step breakdown

STEP 067: **Velocity counter service for card tokens and IP addresses** (`docs/final/STEP_PLAN_250.md`
line 869), from `docs/final/FEATURE_LIST.md` line 197 ("Card and IP velocity limits exist with defaults
in config") and line 196 (a blacklist entry is a card token or a provider fingerprint), together with the
sixth signal of STEP 066 whose reading this STEP has to answer, inside the security block 056-067.

## What already exists, and what is missing

- `migrations/0056_velocity_counters.sql` (STEP 030) - the table: one row per card fingerprint or address
  and window, `window_seconds between 1 and 2592000`, `limit_value >= 1`, `hit_count >= limit_value` when
  `exceeded_at` is written, two partial unique keys over `(subject, window_start, window_seconds)`, a
  guard trigger that freezes the subject, the window and the limit, counts up only, writes the breach once,
  moves `last_hit_at` forward only and refuses a delete, RLS default-deny, and `company_id` forced to null.
- `migrations/0074_platform_and_audit_policies.sql` - the two policies of that table (super admin all,
  compliance and KYC select).
- `migrations/0092_rate_limit_windows.sql` (STEP 055) - the shape to copy: one function, one statement,
  `insert ... on conflict ... do update ... where hits < limit`, `set search_path = ''`, every object
  schema qualified, an answer that describes the state after the attempt.
- `lib/security/rate-limit.ts` (STEP 062) - `canonicalRateLimitAddress`, the one spelling of an address
  that an IP counter has to use, and the client/reason style this module follows.
- `lib/security/fraud.ts` (STEP 066) - `FraudSignalLookups.readVelocity`, the exact contract this STEP
  fills: `{ kind: "card" | "ip", value }` in, `{ hits, limit }` out, with the breach test `hits >= limit`
  that `0056` records.
- `lib/security/audit.ts` (STEP 063) - the entry shape and `auditEntryProblem`.

What is missing is the middle: nothing moves a counter, so the two velocity signals of STEP 066 can only be
fed by a caller that reads and writes the table itself - which loses increments under the burst the limit
exists for - and nothing retires a window, so `0056`'s retention comment has no implementation.

## The decisions this STEP makes

1. **The counting is one SQL statement, in a migration.** A service that read the count and wrote it back
   would lose increments under exactly the burst a velocity limit exists for, so `0093` adds
   `public.consume_velocity`: it aligns the window to the epoch, inserts the first hit or increments the
   row that already exists, and answers the count, the limit, the window and the two verdicts from one
   statement, the way `0092` does for rate limiting.
2. **Two branches, because there are two partial unique keys.** A table with two partial indexes has no
   single conflict target: the card index is inferred with `on conflict (card_fingerprint, window_start,
   window_seconds) where ...` and the address index with the same shape over `ip_address`, so the function
   branches once on the subject it validated. Each branch is one complete insert.
3. **The first breach is computed, not stored.** The count rises by one from one against a frozen limit, so
   `hits = limit` happens exactly once: `counter_first_breach` is that hit, and it is when the audit entry
   is written. `counter_exceeded` is `hits >= limit`, which is the comparison `0056` records.
4. **The counter is the platform's.** `0056` forces `company_id` to null, so the audit entry of a breach is
   on the platform chain, names the subject kind, carries the fingerprint for a card, and keeps the address
   in the entry's own field rather than repeating it in the payload.
5. **A card is a fingerprint, never a number.** The subject is the SHA-256 of the processor's opaque token -
   the same value `0055` blacklists - and a string that looks like a card number is refused rather than
   hashed, because a hash of a number is still a way to recognise the number. A value that is already a
   64 hex fingerprint is accepted unchanged, so the payment page that hashed the token for the blacklist
   counts the same card.
6. **One spelling of an address.** `canonicalRateLimitAddress` from STEP 062 decides, because two spellings
   of one IPv6 address are one machine and two counters for one attacker is not a limit.
7. **The window and the limit are the row's.** The service validates the policy against the bounds of
   `0056`, sends the policy's limit, and then reports the limit the row applied - a limit changed inside a
   window takes effect in the next window and never rewrites one that already decided a payment.
8. **One hit per attempt, so there is no read-only path.** `createVelocityReader` is the shape STEP 066
   consumes and it counts; a reader that did not would let an attacker retry for free.
9. **Fail closed.** A failed call, an answer in any other shape, and a clock that cannot place a window are
   refusals, never the first attempt of a fresh window: "the counter was down" and "this card is new" are
   opposite facts.
10. **The sweep removes, and refuses to remove too much.** The migration gate forbids a forward file from
    deleting a row, so the retention is not SQL: `sweepVelocityWindows` gives a cutoff to a client that can
    delete and refuses a retention shorter than the widest window in force, because deleting a live counter
    frees its key for a fresh count of zero.

## Owned paths

New: `migrations/0093_velocity_counter_consume.sql`, `migrations/0093_velocity_counter_consume.down.sql`,
`lib/security/velocity.ts`, `docs/planning/STEP_067_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_067_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`, and `migrations/` is append-only, so nothing else is touched. No route
(the payment core is STEPs 127-146), no job registration (`lib/jobs/` is STEP 011's, and the retention job
calls this module's sweep), no i18n string (nothing renders a count), `package.json` untouched.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_066_COMPLETED.md` (committed `5bf2c3b`), `STEP_PLAN_250.md` line 869, feature list lines 196-197,
master prompt rules 9, 14 and 17, the ownership rules, `0056_velocity_counters.sql`,
`0092_rate_limit_windows.sql`, `0074_platform_and_audit_policies.sql`, `lib/security/rate-limit.ts`,
`lib/security/fraud.ts` and `lib/security/audit.ts`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

`migrations/0093_velocity_counter_consume.sql` adds one function, `public.consume_velocity(p_subject,
p_card_fingerprint, p_ip_address, p_limit, p_window_seconds, p_now)`, returning the six values of one hit:
`counter_hits`, `counter_limit`, `counter_window_start`, `counter_window_seconds`, `counter_exceeded`,
`counter_first_breach`. It validates the subject against the field that carries it, the limit, the window
and the instant; aligns the window to the epoch; and moves the row with `insert ... on conflict ... do
update`, touching only `hit_count`, `last_hit_at` and `exceeded_at`, because `0056`'s guard trigger refuses
anything else. `created_at` is written as the caller's instant so `velocity_counters_start_check`
(`window_start <= created_at`) cannot fail on a clock a second ahead of the transaction. The rollback drops
the function and leaves the rows, which are `0056`'s record.

The forward file is transactional, ASCII, contiguous (`0093` follows `0092`) and deletes no row, so the
migration gate passes; its replay and rollback against a real Postgres are recorded in the handoff.

## Sub-step 4 - The core logic

`lib/security/velocity.ts`:

- `VELOCITY_CONSUME_FUNCTION`, `VELOCITY_TABLE`, `VELOCITY_RULE`, `VELOCITY_AUDIT_ACTION`,
  `VELOCITY_SUBJECTS`, `VELOCITY_CARD_FINGERPRINT_PATTERN`, `VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH`,
  `VELOCITY_MINIMUM_WINDOW_SECONDS`, `VELOCITY_MAXIMUM_WINDOW_SECONDS`, `VELOCITY_MAXIMUM_LIMIT`,
  `VELOCITY_RETENTION_SECONDS`, `VELOCITY_DEFAULT_POLICY`, `VELOCITY_PROBLEMS` - the vocabularies, the
  bounds of `0056` and the defaults of section 18;
- `VelocitySubjectKind`, `VelocityRule`, `VelocityPolicy`, `VelocityCounterSubject`, `VelocityReading`,
  `VelocityCounterClient`, `VelocitySweepClient`, `VelocityCounterOptions`, `VelocityAuditEntry`,
  `VelocityAuditTrail`, `VelocityAuditContext`, `VelocityReaderOptions`, `VelocitySweepOptions` - the inputs
  and outputs;
- `isVelocitySubject`, `velocityCardFingerprint`, `canonicalVelocityAddress`, `canonicalVelocitySubject` -
  the subject, as the row stores it;
- `velocityWindowStart`, `velocityRetryAfter` - the window arithmetic, used to check the answer;
- `consumeVelocity` - one hit, one reading;
- `createVelocityReader` - the same call in the shape STEP 066's `FraudSignalLookups.readVelocity` asks for;
- `velocityAuditEntry` - the entry the hit that reached the limit appends;
- `sweepVelocityWindows` - the retention, with the refusal that keeps it honest.

## Sub-step 5 - Routes and jobs

None to connect, and the same reasoning as STEP 066. `createVelocityReader` is what the payment core of
STEPs 127-146 passes to `fraudDecide`, and `sweepVelocityWindows` is what the retention job calls; the
schedule belongs to the jobs STEP that owns `lib/jobs/`, and a cron entry written here would be a second
place that decides when a window may be removed. The gate asserts that exactly one migration defines the
counting function and that exactly one module calls it.

## Sub-step 6 - UI

Not applicable: nothing renders a count or a wait. The sentence a payer reads when a payment is held belongs
to the payment page of section 18, which is a later STEP's page with its own catalogue entries, and the
operator's view of a breached counter is a report, not this STEP.

## Sub-step 7 - Security proof

`checkVelocityVocabulary`, `checkVelocityConsumption`, `checkVelocityAudit`, `checkVelocitySweep` and
`checkVelocityWiring` in `lib/security/verify.ts`: the vocabularies, the frozen lists, the bounds compared
with `0056`'s own text and the defaults of section 18; the fingerprint (deterministic, 64 hex, ten refused
tokens including three card numbers); the subject (a token, an existing fingerprint, an address, two
spellings of one address, an unknown kind, a string that is not an address); the window and the wait on and
around their boundaries; one hit per attempt with the exact six arguments `0093` declares; the frozen limit
in a changed policy; five hits to a breach and two past it; a second window and a second subject; seven
invalid policies and a policy with no rule; five invalid clocks; a failing client; twenty-three answers in
the wrong shape; the audit entry (once per window, the payload, the platform chain, the address in its own
field, the audit module's own validation, a failing trail that never fails the payment); the sweep (the
cutoff to the millisecond, the retention floor against the widest window in force, five invalid retentions,
a failing store and three impossible counts); and the wiring (STEP 062's address rule, STEP 066's contract
imported and not reversed, no log, no environment read, no request, no `any`, no SQL of its own; the
migration's two branches, its conflict targets, its guards and its silence about the limit, the window and
`deleted_at`; the rollback; and the one definition and one caller in the tree).

Twenty-eight mutation controls, all caught: a breach test of `>` instead of `>=`; a first breach loosened
to `<=`; the answer's window no longer compared with the window asked about; its length unchecked; its
limit unbounded; a count of zero accepted; a wait allowed to be zero; a card number hashed instead of
refused; the token ceiling removed; a token with a space hashed; an existing fingerprint hashed again; an
address not canonicalised; a policy limit of zero accepted; the policy window ceiling removed; a clock not
validated; a failed call that is not an `AppError`; every hit audited rather than the first breach; an entry
that claims a company; an address breach carrying a fingerprint; a retention shorter than the window; a
cutoff that ignores the retention; a negative sweep count accepted; a reader answering more than the
contract; an instant that is not the one the window was built from; an address hit sending a fingerprint;
an audit outage failing the payment; and two mutants of the migration (a first breach on every hit, and a
rewritten breach instant).

One thing the corpus changed: the first draft also compared the token with its own trim, which the token
pattern already refuses - a guard no case could exercise, because a spaced token never reaches it. It is
gone, and the ten refused tokens prove the pattern instead. The same pass added a direct check of the wait
past the end of a window, because the floor of one second was otherwise only reachable through a row the
service would reject.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 067: Velocity counter service for card tokens and IP addresses` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_067_COMPLETED.md`.
