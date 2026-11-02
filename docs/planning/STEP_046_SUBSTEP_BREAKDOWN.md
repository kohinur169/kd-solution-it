// path: docs/planning/STEP_046_SUBSTEP_BREAKDOWN.md
# STEP 046 sub-step breakdown

Feature: **owner email alert when a login lock starts** (`docs/final/STEP_PLAN_250.md` line 616),
from `docs/final/FEATURE_LIST.md` section 22 (LR-022): "The owner receives an email alert when the
lock starts." Owned paths: `lib/auth/lock-alert.ts`, the two call sites of the lock service, the
alert wiring in `lib/auth/runtime.ts` and the two auth routes, `migrations/0086_*`,
`lib/i18n/strings/en.ts`, `lib/auth/verify.ts`, `lib/auth/README.md`, this breakdown and the handoff.

## 1. Read the ground first, then check it

- FEATURE_LIST section 22 (lines 236-241), section 23 (lines 248-262) and the plan's section split:
  **STEP 221-230 owns the email system** (`lib/email/`, SMTP and API configuration, template editor,
  retry sweep). SECTION 22 says *who is told and when*; section 23 says *how the email is sent*.
- `docs/handoffs/STEP_045_COMPLETED.md`, whose "seams" section names this STEP: "`owner_alerted_at`
  is null until STEP 046 sends the email" and "audit `user.login_locked` carries `triggered_by`".
- `git status`, `git log`, `git rev-parse HEAD` and `npm run verify` - all green at `5e35b0a` before
  the first edit, so there was no pre-existing defect to fix first.

## 2. What already existed, and what was missing

| Piece | Where | State before STEP 046 |
| --- | --- | --- |
| the lock row and its alert column | `0012` `account_locks.owner_alerted_at` | complete, never written |
| the email queue | `0061` `email_send_logs` | complete: `queued/sent/failed/dropped`, guard trigger, retries, `reference_kind = 'account'` |
| the template key | `0060`/`0061` CHECK lists | **`login_lock_alert` is already a legal template key** |
| the sending method | `0059` `email_settings` (`smtp`/`api`, `status = 'active'`) | complete, configured by STEP 221 |
| the transport | - | **absent by design: STEP 221-230** |
| the link lock -> email | - | **missing** |
| the alert service | - | **missing** |

So this STEP adds one column, one index, two constraints, one service, one dependency through two
sign in paths and one audit action. It does **not** add a table, a transport or a job: `0061` already
is the queue, and a second queue would be a second truth about what the owner was told.

## 3. Design decisions taken before writing code

| Question | Decision | Why |
| --- | --- | --- |
| New outbox table, or `email_send_logs`? | `email_send_logs` | `0061` already models queue, retries, status walk and the `login_lock_alert` key; a new table would duplicate all four |
| Who sends the email? | STEP 221-230 | the plan assigns `lib/email/` and the SMTP configuration to those STEPs; STEP 046 that invented a transport would collide with them |
| Who is the recipient? | the company owner: live `role_assignments` row with `role = 'owner'`, joined to `users.email` | `0004` scopes the owner role to exactly one company; emailing "somebody at the company" would be a guess |
| What if there is no owner, or no configured sender? | an answer (`no_owner`, `sender_not_configured`), no email, a log line, and the lock still starts | section 22's lock is not conditional on the mail system, and 221 has not run yet in a fresh deployment |
| When is `owner_alerted_at` written? | with `alert_send_id`, when the email is queued | delivery state already lives in `email_send_logs.status`; a second copy on the lock would be a second truth |
| How is "one alert per lock" enforced? | claim in the database: `update ... where alert_send_id is null`, read back, drop the losing row | a read-then-write check races with the second concurrent failure that is exactly the case here; the compensation keeps one email and a truthful log |
| What links a lock to its email? | `account_locks.alert_send_id` + FK + unique partial index + pair check (`0086`) | the FK alone allows two locks per email and an alerted lock without a pointer |
| Does the alert run on the request path? | yes, best effort, after the lock row and its audit entry exist | the queue row must exist for STEP 227 to sweep, and a mail problem must never fail a refusal |
| Is the address audit logged? | no | the chain is forever; an address that must be erasable later does not belong in it |
| Where does the subject come from? | `lib/i18n/strings/en.ts` (`email.lockAlert.subject`) | rule 1: English strings live in the catalog; `0061` requires a subject at queue time and no template row is seeded yet |

## 4. Sub-steps, in order

1. **Migration `0086_account_lock_alert`** - column, FK, backfill from the log, pair check, unique
   partial index; rollback drops all three and keeps both tables' rows. Proven with PGlite:
   apply, constraints, unique link, rollback, re-apply, and three negative controls.
2. **`lib/auth/lock-alert.ts`** - `createLockAlertNotifier`: open lock, idempotency, active sending
   method, owner address, queue row, claim, compensation, audit, and a `Promise<LockAlertOutcome>`
   that never rejects.
3. **Wire it in** - `FailedSignInDependencies.alerts` is required, `signInMerchant` and
   `completeTwoFactorChallenge` pass it through, `recordFailedSignIn` calls it only when it opened the
   lock and catches the whole lock step, `lib/auth/runtime.ts` builds it once, both routes pass
   `runtime.lockAlerts`.
4. **The catalog string** - `email.lockAlert.subject` (section 23 template key `login_lock_alert`).
5. **The gate** - `lib/auth/verify.ts`: `checkLockAlert()` (a REST double for the six tables, one
   check per outcome plus the race and the silent queue), `createInMemoryLockAlerts()` for the sign in
   and second factor paths, and the "a broken alert path cannot stop a lock" check.
6. **UI** - not applicable: section 22 asks for an email to the owner, and the sign in screen already
   tells the merchant the office unlocks only after contacting the owner (STEP 045). A screen that
   showed alert delivery state belongs to the office unlock screen of STEP 047.
7. **Security** - the alert discloses nothing to the stranger (it runs after the password), the
   recipient is resolved from a role assignment rather than from input, the address never reaches the
   audit chain or a log line, and the queue row cannot be forged from a request body.
8. **Verification** - `node lib/auth/verify.ts` (1162 checks), `npx tsc --noEmit`, `npm run lint`,
   `npm run verify` (every gate and the production build), the PGlite proof, and a live dev probe.

## 5. Acceptance, in the words of the title

- "when the lock starts": the alert is asked for exactly once per lock, at the moment the lock row is
  created, and never for a lock that already existed.
- "email alert": one `email_send_logs` row with template `login_lock_alert`, the active sending
  method, the owner's address, and a reference back to the locked account.
- "the owner": the recipient is the live `owner` role assignment of the account's company.
- "nothing breaks": no owner, no sender, a database failure and a lost race all leave the lock in
  place, answer with a value, and log a line an operator can act on.
