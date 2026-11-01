// path: docs/planning/STEP_045_SUBSTEP_BREAKDOWN.md
# STEP 045 sub-step breakdown

Feature: **login lock service: two failures trigger a two hour lock in database**
(`docs/final/STEP_PLAN_250.md` line 605), from `docs/final/FEATURE_LIST.md` section 22 (LR-022).
Owner of the paths below: STEP 045 only (auth STEPs 037-055 own `app/(auth)`, `app/api/auth`,
`lib/auth`, and their own migration numbers).

## 1. Read the ground first, then check it

- FEATURE_LIST section 22, lines 236-241: the two-hours rule, four consequences (a correct password
  does not sign in, password reset is disabled, changing the password does not clear the lock), the
  owner alert, the office unlock, and "counters and lock state are stored in the database and survive
  server restarts".
- MASTER_PROMPT working method and production rules; `docs/handoffs/STEP_044_COMPLETED.md`, whose
  "seams" section says the lock must not count reset requests - it counts sign in attempts only.
- `git log`, `git status`, `git ls-remote`, every gate - all green at `33dc45f` before any edit.

## 2. What already existed, and what was missing

| Piece | Where | State before STEP 045 |
| --- | --- | --- |
| the attempt row | `0011` `login_attempts`, written by `login-attempts.ts` | complete; the counter is a query, not a column |
| the lock itself | `0012` `account_locks` | complete: two hour check, live key, unlock columns, owner alert column |
| the counter query | `login_attempts_user_idx (user_id, created_at desc)` | indexed per account, not per account and factor |
| the decision | `signin.ts` had a comment naming this STEP as the place the lock question goes | missing |
| the answer | no code for "locked" in the error catalogue | missing |

So this STEP adds one index, one service, two call sites and one error code. It adds no table: `0012`
was written for this sentence, and a second lock table would be a second truth about who is locked.

## 3. Design decisions taken before writing code

| Question | Decision | Why |
| --- | --- | --- |
| Where is "two consecutive" counted? | a query over `login_attempts`, per account and factor | `0012.triggered_by` documents per factor; the database is what survives a restart |
| Does a Turnstile refusal break a streak? | no | it is not a credential check; counting it would let a bot extend a lock it cannot otherwise reach |
| Does a `blocked` attempt break a streak? | no | otherwise one blocked sign in would erase the evidence that caused the lock |
| Is the lock asked before or after the password? | after | before it, the answer would confirm that an address has an account |
| What does a wrong password on a locked account answer? | the generic rejection | section 22 forbids revealing whether an account exists |
| What happens to the provider session of a refused sign in? | signed out | a session nobody will use is a live key to an account that is meant to be closed |
| What does an open row whose two hours passed mean? | not locked, and closed on the next failure | the live key would otherwise make the account unlockable by time but lockable by nothing |
| Where does the owner alert go? | STEP 046, reading the `user.login_locked` audit entry | the column `owner_alerted_at` already exists and stays null |
| Where does the office unlock go? | STEP 047 | `0012` has the columns and the contact-confirmation check |

## 4. Owned paths

| Path | Why |
| --- | --- |
| `migrations/0085_login_attempt_factor_idx.sql` + `.down.sql` | The index behind the streak query. |
| `lib/auth/locks.ts` | `readAccountLock`, `countConsecutiveFailures`, `recordFailedSignIn`, `assertAccountUnlocked`, `accountLockError`. |
| `lib/auth/signin.ts` | The address lookup that attributes a failure, and the lock question after the password. |
| `lib/auth/two-factor-login.ts` | The lock question before the code, and the failure that counts toward the code factor. |
| `lib/errors/codes.ts`, `lib/i18n/strings/en.ts` | One new code, `ACCOUNT_LOCKED` (423), and four strings. |
| `app/(auth)/signin/signin-form.tsx` | The 423 sentence on the password step and on the code step. |
| `lib/auth/verify.ts` | `checkLoginLock()` and the lock table double the two fixtures share. |
| `lib/auth/README.md`, `app/(auth)/README.md` | Rules 44-48 and the two screens. |
| `docs/planning/STEP_045_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_045_COMPLETED.md` | This file and the handoff. |

## 5. Sub-steps, in the order they were done

1. **Database first.** `0085` indexes `login_attempts (user_id, factor, created_at desc)` for the
   streak query, with a rollback that drops the index and nothing else. Proven on PGlite against
   `0011` + `0012` before any service code: the two hour ceiling, the live key, both closures, the
   version trigger, default-deny, and both directions of `0085` - 18 checks.
2. **The service.** `locks.ts`: the constants of section 22, `readAccountLock` (failing closed),
   `countConsecutiveFailures` (per factor, success ends, blocked and challenged skip),
   `recordFailedSignIn` (never throws), `assertAccountUnlocked` for the later steps,
   `accountLockError`.
3. **The two call sites.** `signInMerchant` resolves the account from the address before the exchange
   so a failure has an account to count against, asks the lock after the password and signs the
   unused provider session out; `completeTwoFactorChallenge` asks the lock before the code and counts
   a wrong code toward the code factor.
4. **The public answer.** `ACCOUNT_LOCKED` at 423, retryable, with `retryAfterSeconds` and a
   `Retry-After` header; the sign in form prints the remaining minutes on both steps.
5. **The gate, the docs, the probe, the commit.**

## 6. What the gate had to prove

- The two hours are exactly `LOGIN_LOCK_DURATION_MS`, and a fresh lock reports 7 200 seconds left.
- One failure writes an attributed attempt row and no lock; the second writes the lock, the
  `user.login_locked` audit entry and the factor; a third opens nothing and audits nothing.
- A success ends the streak; a `challenged` and a `blocked` row do not.
- The factors are counted separately, and the lock names the factor that reached two.
- An expired lock reads as open, the next failure closes the expired row and writes a second one; an
  office unlock frees the account the same way.
- The service touches only `account_locks` and `login_attempts`, which is why changing the password
  cannot clear a lock.
- `ACCOUNT_LOCKED` is 423, retryable, and carries the remaining seconds.
- Sign in: a correct password on a locked account is refused, the attempt is `blocked`, the provider
  session is signed out, the refusal is audited and no sign in is; a changed password changes nothing;
  a wrong password on a locked account is still the generic sentence; two wrong passwords lock the
  account; three wrong passwords on an address with no account lock nothing.
- Second factor: two wrong codes lock with `triggered_by = "totp"`, and a locked account refuses even
  a correct code with no session.
