// path: docs/handoffs/STEP_045_COMPLETED.md
# STEP 045 Completed - Handoff

Feature: **login lock service: two failures trigger a two hour lock in database**
(`docs/final/STEP_PLAN_250.md` line 605), from `docs/final/FEATURE_LIST.md` section 22 (LR-022).

## What was delivered

1. **Two consecutive failures lock the account, in the database.** `recordFailedSignIn` writes the
   attempt row and counts the newest `login_attempts` rows of that account and that factor; on the
   second it writes one `account_locks` row with `triggered_by` set to the factor that reached two and
   an `expires_at` exactly two hours later. Nothing about a lock lives in a process, so a restart
   cannot release one.
2. **A locked account does not sign in, even with the right password.** `signInMerchant` asks the lock
   after the password step; when it is running, the provider session that exchange created is signed
   out again, the attempt is recorded as `blocked`, the refusal is audited as `user.signin_blocked`
   and the answer is `423 ACCOUNT_LOCKED` with `retryAfterSeconds` (and a `Retry-After` header).
3. **The second factor counts too.** `completeTwoFactorChallenge` asks the lock before the code, so a
   locked account refuses even a correct code, and a wrong code counts toward `triggered_by = "totp"`.
   Two wrong codes lock the account.
4. **The lock never becomes an account oracle.** A wrong password on a locked account answers the one
   generic sentence - the lock is only named once the password is right, which means the person
   reading it already holds the credential.
5. **Nothing a merchant can do clears it.** The service never writes `users`, so changing the password
   cannot touch a lock; an expired row is closed by the next failure before a new lock is written,
   because the live key would otherwise make the account unlockable by time and lockable by nothing.
6. **The screen explains it.** Both the password step and the code step of the sign in form read the
   423 and print the remaining minutes instead of asking for the password again.

## The defect found while reading, and its disposition

No pre-existing defect was open at `33dc45f`: the previous handoff, the working tree, the remote and
all eleven gates were green before the first edit. One stale sentence was found and deliberately **not**
edited: `lib/auth/login-attempts.ts` still says "STEP 045 builds the lock on that query" in its header
comment. That file belongs to STEP 039 and a comment edit is not this STEP's to make; the statement is
true of the module it describes, and this STEP is the one it points at.

## Migration

`migrations/0085_login_attempt_factor_idx.sql` (forward) and `.down.sql` (rollback).

No table and no column is added. `0012_account_locks` already models the lock of section 22 - one row
per lock, `expires_at` defaulting to `locked_at + 2 hours` with a check that refuses anything later,
`account_locks_live_key` allowing one open lock per account, the mutually exclusive closures
(`unlocked_at` + `unlocked_by` versus `expired_at`), `owner_alerted_at` for STEP 046, and the
contact-confirmation check STEP 047 will use. What was missing was the index behind the counter, which
STEP 045 now runs on every failure:

```sql
create index login_attempts_factor_streak_idx
  on public.login_attempts (user_id, factor, created_at desc)
  where user_id is not null and deleted_at is null;
```

**Proof (PGlite 0.5.14, PostgreSQL engine, 18/18 checks), against `0011` and `0012` verbatim:**

- a lock expires exactly two hours after it starts (the default, not a convention);
- a second open lock for one account is refused by `account_locks_live_key`;
- a three hour lock is refused by the window check;
- an unlock without `owner_contact_confirmed_at` is refused, and accepted once the contact is recorded,
  after which the slot is free for a new lock;
- an expiry stamped before `expires_at` is refused, and accepted at `expires_at`, after which the slot
  is free;
- the metadata trigger bumps `version` on update; the table has row level security on and exactly one
  policy;
- the streak query reads newest first, and with 2 000 code attempts behind it the planner answers the
  password streak as an index scan and never as a sequential scan (`EXPLAIN`, no planner settings
  forced);
- the rollback drops the index, and the forward file applies again.

`node migrations/verify.ts`: 2 495 checks, 85 migrations, 72 tables, every forward file transactional
and default-deny.

## Files

| Path | Change |
| --- | --- |
| `migrations/0085_login_attempt_factor_idx.sql`, `.down.sql` | new |
| `lib/auth/locks.ts` | new: the lock, the counter, the guard |
| `lib/auth/signin.ts` | the address lookup that attributes a failure, and the lock question |
| `lib/auth/two-factor-login.ts` | the lock question before the code, and the code failure that counts |
| `lib/errors/codes.ts` | `ACCOUNT_LOCKED` (423, retryable) |
| `lib/i18n/strings/en.ts` | 4 strings: `errors.accountLocked`, `signin.lockedTitle`, `signin.locked`, `signin.secondFactorLocked` |
| `app/(auth)/signin/signin-form.tsx` | the 423 sentence on both steps |
| `lib/auth/verify.ts` | 102 new checks (996 -> 1 098) and the lock table double |
| `lib/auth/README.md` | rules 44-48 |
| `app/(auth)/README.md` | what the two 423 answers are |
| `docs/planning/STEP_045_SUBSTEP_BREAKDOWN.md` | new |
| `docs/handoffs/STEP_045_COMPLETED.md` | this file |

## Behaviour proof (acceptance checklist)

1. **Two failures lock the account** - proven twice: at the service level (two `recordFailedSignIn`
   calls on one account with one lock row and a `user.login_locked` audit entry), and end to end
   (two `signInMerchant` calls with a rejected provider answer produce one `account_locks` row with
   `triggered_by = "password"` naming the account of the address).
2. **The lock lasts two hours** - the row's `expires_at - locked_at` is exactly `7 200 000` ms, the
   database refuses anything longer, and a fresh lock reports 7 200 seconds remaining.
3. **A correct password does not sign in during the lock** - `ACCOUNT_LOCKED` with
   `retryAfterSeconds: 6 600` for a lock with 6 600 seconds left, no cookie, the attempt recorded as
   `blocked`, the provider session signed out, and no `user.signed_in` entry.
4. **A wrong password during the lock reveals nothing** - `AUTHENTICATION_REQUIRED`, and the attempt
   is not answered as a block.
5. **Changing the password does not clear the lock** - the gate proves the service touches only
   `account_locks` and `login_attempts`, and a sign in with the "changed" password on a locked account
   is still refused.
6. **A failed second factor counts** - two wrong codes lock with `triggered_by = "totp"`, and the next
   attempt with a correct code is refused with `ACCOUNT_LOCKED`.
7. **An unknown address cannot lock anything** - three failed attempts on an address with no account
   leave zero lock rows, and the attempt rows carry `email_hash` with no `user_id`.
8. **Expiry and unlock both free the account** - an expired lock reads as open, the next failure closes
   the expired row and writes a new one; an office unlock does the same.
9. **The negative controls fired** - with `LOGIN_LOCK_FAILURE_THRESHOLD` changed to 3 the gate failed
   with 31 problems; with the lock question removed from `signInMerchant` it failed with 9, including
   "a correct password on a locked account is refused (nothing was rejected)".

## Verification

- `node lib/auth/verify.ts`: **1 098 checks** (996 before this STEP).
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **127 source files**, env,
  config, i18n **203 messages / 8 placeholders**, logger 117, errors **202 checks / 15 codes**, lint 77
  checks / 26 rules, shell 174 checks / 35 files, jobs 110, migrations **2 495 checks / 85 migrations /
  72 tables**, type check, lint, build.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Live probe on port 3000 (server stopped afterwards, `.env.local` is git ignored): `GET /signin`
  answers 200 with the form and the recovery link; `POST /api/auth/signin` with a malformed body
  answers `401 AUTHENTICATION_REQUIRED` (a form that is not a form is not a fact about an account);
  with a well formed body it answers `502 DEPENDENCY_FAILED`, from the first database read the route
  makes (the Turnstile setting) - this sandbox has no Supabase project, so no lock can be exercised
  over HTTP here. The lock's HTTP contract is proven directly through `toErrorResponse`: `423`, header
  `Retry-After: 6600`, `cache-control: no-store, max-age=0`, and the catalogue message with no
  internal vocabulary.

## Design notes worth keeping

- **The address is read before the exchange.** Without it a failed password could only be recorded by
  the hash of the address, and section 22's counter is per account. The lookup changes no answer - it
  decides what the attempt row says - and `users_email_key` makes it one index lookup.
- **The lock is asked after the password, never before.** Answering "locked" to anyone who types an
  address would be an account directory.
- **The read fails closed, the count is best effort.** "The database did not answer" must never mean
  "the account is open", so `readAccountLock` propagates; a counter that could not be written must not
  turn a rejection into an outage, so `recordFailedSignIn` swallows.
- **`blocked` and `challenged` attempts neither count nor reset.** A blocked attempt resetting the
  streak would let one sign in erase the reason the lock exists.
- **The provider session is signed out** when a correct password meets a lock: the session exists only
  because the password was right, and leaving it alive would be a live key to a closed account.
- **An expired row is closed before a new lock.** `account_locks_live_key` allows one open row, so a
  row that is only closed by the clock would block every future lock for that account.

## Package request (still open, unchanged)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`. No new dependency is needed through STEP 045.

## Seams for the next STEPs

- **046 (owner alert when a lock starts):** the lock row is written here with `owner_alerted_at` null,
  and the audit entry `user.login_locked` carries `triggered_by`, `failed_attempts`, `locked_at` and
  `locked_until` - the alert is a reader of those two facts, and the retry job finds an unsent alert by
  querying `owner_alerted_at is null`.
- **047 (admin unlock endpoint):** `assertAccountUnlocked` and `readAccountLock` are the read side;
  the write side is `0012`'s columns (`owner_contact_confirmed_at`, `unlocked_at`, `unlocked_by`,
  `unlock_note`) with the check that refuses an unlock before the contact is confirmed. This STEP
  never writes them.
- **048 (generic authentication errors):** the lock adds no new revealing sentence; `ACCOUNT_LOCKED` is
  reachable only after the password is right, and that asymmetry must survive STEP 048.
- **Password reset:** section 22 disables it during a lock. The route does not exist yet; when it does,
  `assertAccountUnlocked(rest, userId, now)` is the one line it needs, and the sentence it throws is
  already translated.
- **055 (rate limiting):** the per-IP limiter sits in front of the route and is separate from this
  per-account lock; the attempt table already carries `ip_address` and its index.
- **Retention:** `login_attempts` grows with every attempt; `login_attempts_created_idx` exists for the
  retention job, and closing locks lets `account_locks` stay one row per incident.
- **Sessions:** an existing session keeps working while its account is locked, because section 22
  speaks about signing in. Instant revocation is STEP 051's, and it will read the same lock row.
