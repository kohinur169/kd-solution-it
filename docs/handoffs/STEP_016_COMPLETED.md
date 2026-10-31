// path: docs/handoffs/STEP_016_COMPLETED.md
# STEP 016 Completed - Handoff

## STEP
- Number and title: STEP 016 - Migration for login attempts and account locks table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger, the migrations gate and its conventions), STEP 013
  (`users`, whose password hash and TOTP state the lock protects, and whose comment in `0003`
  already reserves the lock for this STEP) and STEP 015 (`sessions`, which records the successful
  sign-in that follows an unlock). The owner asked for this STEP in five sub-STEPS, one approval at
  a time; the plan is `docs/planning/STEP_016_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0011_login_attempts.sql and 0011_login_attempts.down.sql - one row per
    authentication attempt, with the factor and outcome vocabularies, the counter, rate limit and
    retention indexes, trigger, RLS and default-deny policy.
  - migrations/0012_account_locks.sql and 0012_account_locks.down.sql - the two hour lock, the owner
    alert and contact instants, the two mutually exclusive closures, the open lock unique index,
    trigger, RLS and policy.
  - docs/planning/STEP_016_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_016_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows, and two new rules: a failure counter is a query over
    the attempt record rather than a stored number, and a lock closes one way with a fixed window.
  - README.md - the database section describes the attempt record and the lock.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0010`, every
  `lib/` module, `config/`, the environment contract, the audit log (017), the permissive RLS
  policies (035), the email templates, and every code STEP including the authentication STEPs
  037-055 that will write these rows. `package.json` is untouched because the migrations gate
  already covers new files.

## Database
- Migrations added (file names): `0011_login_attempts` and `0012_account_locks`, each with its
  `.down.sql`. Together they create two tables, 28 columns, 30 constraints, seven indexes, two
  triggers, two policies and 21 comments, and the schema now holds twelve tables in total.
- Shape: `login_attempts` has 12 columns, 13 constraints, five indexes and nine comments;
  `account_locks` has 16 columns, 17 constraints, three indexes and twelve comments.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All twelve
  rollbacks ran in reverse dependency order on a populated database; afterwards the catalog reported
  0 public tables, 0 policies, 0 functions in `public` and 0 custom triggers, and the twelve forward
  files applied again to a second empty database, recreating exactly twelve tables and twelve
  policies. The environment has no Docker and no Supabase CLI, so the server was a real PostgreSQL
  16.2 started locally from the `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proof seeded synthetic password hashes, a
  synthetic device key and reserved documentation addresses (203.0.113.0/24, 198.51.100.0/24,
  192.0.2.0/24) in throwaway local databases.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three throwaway scripts ran against the local PostgreSQL 16.2, with 29, 28 and 19 checks
respectively; all passed and each ended with `PROOF COMPLETE`. They covered:

1. **Forward apply.** `0001` to `0012` applied in order and produced twelve tables, twelve policies
   and twelve triggers.
2. **Every outcome is storable, nothing else is.** A known account failure, an unknown address
   failure, `blocked` and `challenged` were accepted; `sms` was refused by
   `login_attempts_factor_check` and `error` by `login_attempts_outcome_check`.
3. **An attempt always names what was tried.** No account and no hash was refused by
   `login_attempts_identity_check`; both at once was refused by
   `login_attempts_identity_known_check`, so a row is never ambiguous about whether the account
   existed.
4. **The address is hashed, never stored, when there is no account.** An uppercase or truncated hash
   was refused by `login_attempts_email_hash_check`, and the unknown address remained countable
   through its hash.
5. **Origins are real addresses.** IPv4 and IPv6 were accepted, `999.1.1.1` was refused by the type
   itself, and a 513 character user agent was refused by `login_attempts_user_agent_check`.
6. **Attempts point at real accounts.** An account id that does not exist was refused by
   `login_attempts_user_fkey`.
7. **The counter is a query.** After two failures, a success and two more failures, the consecutive
   failure count was exactly 2, and the per-address query answered the rate limit window. The
   counter resets to 0 after a success.
8. **The indexes work and their limits are visible.** The address index is
   `(ip_address, created_at desc) where deleted_at is null`; the planner used it for the rate limit
   query only when the query also filtered `deleted_at is null`. That partial-index rule is recorded
   for the STEP that writes the queries.
9. **The lock window is the policy.** A default lock measured exactly 2:00:00; a three hour lock and
   a lock ending before it started were both refused by `account_locks_window_check`.
10. **One open lock, and history kept.** A second open lock was refused by
    `account_locks_live_key`; after an unlock the account could be locked again while the closed row
    stayed as history.
11. **An unlock is a person who proved contact.** An unlock instant without an officer was refused
    by `account_locks_unlock_pair_check`; an officer without an instant likewise; an unlock without
    `owner_contact_confirmed_at` was refused by `account_locks_unlock_contact_check`; an officer who
    does not exist was refused by `account_locks_unlocked_by_fkey`.
12. **A lock closes one way, and not early.** Unlock together with expiry was refused by
    `account_locks_closure_check`; `expired_at` before `expires_at` was refused by
    `account_locks_expiry_time_check`; the alert or the contact recorded before `locked_at` was
    refused by their checks; a 281 character note was refused by
    `account_locks_unlock_note_check`; an unknown trigger factor was refused by
    `account_locks_triggered_by_check`.
13. **Section 22 end to end.** Two consecutive password failures reached the threshold, the lock
    opened, a correct password during the lock was recorded as `blocked` and produced no session,
    changing the password left the lock untouched, the alert instant was recorded, the office
    unlocked only after the contact was confirmed, the successful sign-in then opened a session, the
    counter reset, a TOTP lock was closed by time, and no lock was left open past its window.
14. **Row level security.** A plain role with select and insert grants saw zero attempts and zero
    locks and could not insert, while the owner saw every row (4 attempts, 2 locks).
15. **Rollback and re-apply.** The twelve rollbacks emptied the `public` schema completely and the
    twelve forward files rebuilt it on a second database.

## Verification
- `npm run check:migrations`: `migrations gate passed: 363 checks, 12 migrations, 12 tables, every
  forward file transactional and default-deny` (303 before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from either
  file, removing `company_id` from either file, inserting a `truncate`, and removing a rollback file.
  The gate is back to 363.
- Behaviour mutation probe: deleting `account_locks_unlock_contact_check` made the cross-table proof
  fail with "an unlock before the owner contact :: the update succeeded". The check was restored and
  all three proofs were green again.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 363 checks; `Compiled successfully`. The route table is unchanged.
- No `TODO`, `FIXME` or `XXX` was added; every SQL and doc file is ASCII.

## Errors Found And Corrected In This STEP
1. **The rate limit index was not usable by the query the STEP describes.** A partial index
   (`where deleted_at is null`) is only usable when the query also filters `deleted_at is null`;
   without it the planner fell back to a sequential scan even with `enable_seqscan = off`. The proof
   now demonstrates both directions and the rule is written down for the authentication STEPs.
2. **Two checks can refuse the same bad write, and the first one wins.** "An unlock without an
   officer" first failed on `account_locks_unlock_contact_check` because the probe had also left the
   contact instant empty. The probe now satisfies the contact rule so that the pair rule is the only
   one violated, and the recorded refusal names the intended constraint.
3. **A check count was asserted before it was measured.** `account_locks` has 17 constraints, not
   the number first written in the plan; the proof caught the difference rather than hiding it.

## Decisions And Limits Left For Later STEPs
- Who may unlock is a permission (`unlock.account` delegated through `office_permissions` from STEP
  014), not a column here. This STEP guarantees the officer is a real account, that the owner
  contact is confirmed, and that the unlock is recorded.
- The two hour window and the two failure threshold live in the constraint and in the auth STEP's
  configuration respectively; the database enforces the ceiling, the service enforces the trigger.
- Sending the lock alert and the unlock confirmation is the email STEP's work; this schema records
  whether the alert was sent (`owner_alerted_at`) so a missing send is visible.
- Retention of attempts and the sweep that closes expired locks are jobs, not migrations: deletion
  stays out of a forward file by rule 5.
- The hash in `email_hash` is computed by the application. The database never hashes a submitted
  address, so it cannot be asked to confirm whether an address exists.
- The hash-chained audit log of every unlock is STEP 017; this table records the facts that log will
  cite.

## Next Chat Notes
- Next in this category is STEP 017 (audit logs, append-only hash chain). It will want the unlock,
  the lock start and the alert send to be chained entries; this STEP deliberately stores the facts
  and not the chain.
- The authentication STEP (037-055) must count failures with `outcome = 'failed'`, order by
  `created_at`, stop at the last `succeeded`, and filter `deleted_at is null` so the partial index
  is used.
- A lock check is `unlocked_at is null and expired_at is null and expires_at > now()` with
  `deleted_at is null`. The unique index only guarantees one open row, not that its window has not
  passed, so the sweep that sets `expired_at` must run and the reader must still compare the clock.
- Do not add a stored failure counter column to `users`: it would be a second truth next to
  `login_attempts` and it would survive a password change in a way the event record does not.
