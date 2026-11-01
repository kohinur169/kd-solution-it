// path: docs/planning/STEP_047_SUBSTEP_BREAKDOWN.md
# STEP 047 sub-step breakdown

Feature: **admin unlock endpoint with permission check and audit entry**
(`docs/final/STEP_PLAN_250.md` line 628), from `docs/final/FEATURE_LIST.md` section 22 (LR-022):
"Unlock is done only by an office role with unlock permission and only after contact with the owner is
confirmed by email. Every unlock is audit logged." Owned paths: `lib/auth/account-unlock.ts`,
`app/api/office/account-locks/unlock/route.ts`, `migrations/0087_*`, `lib/i18n/strings/en.ts`,
`lib/auth/verify.ts`, `lib/auth/README.md`, this breakdown and the handoff.

## 1. Read the ground first, then check it

- FEATURE_LIST section 22 (the unlock sentence and the lock rules around it), section 2 (roles and
  "every permission grant, change and use is audit logged"), section 23 ("account unlock
  confirmation" is one of the automatic activity emails).
- The plan's own seams: **STEP 053** owns step-up reauthentication for sensitive actions, **STEP 078**
  owns the account unlock management screen for permitted office roles, **STEP 227** owns the email
  retry sweep. STEP 047 therefore builds the service and the endpoint, and neither the screen nor the
  second proof of identity.
- `docs/handoffs/STEP_046_COMPLETED.md`, whose "seams" section hands this STEP
  `alert_send_id`/`owner_alerted_at` and the still-unwritten `owner_contact_confirmed_at`,
  `unlocked_at`, `unlocked_by`, `unlock_note`.
- `git status`, `git log`, `git rev-parse HEAD`: clean at `7f43487`, tree and remote in step, before
  the first edit.

## 2. What already existed, and what was missing

| Piece | Where | State before STEP 047 |
| --- | --- | --- |
| the lock row and its unlock columns | `0012` `account_locks` | complete: `owner_contact_confirmed_at`, `unlocked_at`, `unlocked_by`, `unlock_note`, the four checks |
| the contact rule | `0012` `account_locks_unlock_contact_check` | complete, never exercised |
| the note rule | `0012` `account_locks_unlock_note_check` | **optional note**: an unlock could be closed with no record |
| the permission model | `0004` roles, `0005` office permissions, `requireAnyRole` | complete, no unlock caller |
| the office route pattern | `app/api/office/2fa-reset-requests/decision` (STEP 043) | complete, reusable |
| the email queue | `0061`, with `account_unlock` among its templates | complete, nothing writes it |
| the unlock service | - | **missing** |
| the endpoint | - | **missing** |

So this STEP adds one constraint, one service, one route, one catalog string and one audit action.

## 3. Design decisions taken before writing code

| Question | Decision | Why |
| --- | --- | --- |
| Who may unlock? | `super_admin`, `ceo`, `compliance_kyc`, `support` | the office roles that talk to a merchant; the owner role is a merchant and must never end its own lock; `finance_ops` is money and `blogger` is content |
| Is a second factor required of the caller? | yes, `hasSatisfiedTwoFactor` | section 22 makes TOTP mandatory for every role holding account, so an office session without one is not a session that ends a lock |
| Where does the permission check live? | in the service, not the route | STEP 078's screen and STEP 053's guard must get the same guards by calling the same function |
| One call or two (contact, then unlock)? | one call with an explicit confirmation and a required note | `0012` has a single text column, so a two-step flow would overwrite the contact record with the unlock note; the audit carries the contact instant either way |
| Is the note required? | yes, in the service **and** in `0087` | the service can be bypassed by a script; the constraint cannot |
| What does an already closed lock answer? | `409 CONFLICT` | `0012` makes the two closures exclusive, and a second decision would rewrite who did what |
| What does a lock whose two hours are over answer? | `409 CONFLICT`, although its row is still open | the sign in service already treats it as open, so unlocking it changes nothing |
| How is a race with a second officer handled? | conditional update (`unlocked_at is null`) plus a read back | the row decides the winner, and the loser sees a conflict instead of a success that never happened |
| Is the unlock audited before or after the write? | after, uncaught | "every unlock is audit logged": an unlock the platform cannot record is a failure the officer must see |
| Is the merchant told? | yes, one `email_send_logs` row with `template_key = 'account_unlock'`, best effort | section 23 lists the unlock confirmation as automatic, and nobody else knows the unlock happened |
| Does the unlock reset the failure streak? | no | section 22 lists two ways out of a lock; a counter reset would be a third |
| Where does the confirmation subject come from? | `lib/i18n/strings/en.ts` (`email.accountUnlock.subject`) | rule 1, and `0061` requires a subject at queue time |

## 4. Sub-steps, in order

1. **Migration `0087_account_lock_unlock_record`** - `unlocked_at is null or unlock_note is not null`,
   added `not valid` and then validated, so a note-less unlock written by hand blocks the deploy
   instead of being ignored; rollback drops the constraint and keeps every row. PGlite proof: 24
   checks over four databases, and two negative controls (the rule replaced by `true`, the `validate`
   line removed).
2. **`lib/auth/account-unlock.ts`** - `unlockAccountLock`: role, second factor, uuid, contact
   confirmation, note, read, refusals, conditional write, read back, audit, and the queued
   confirmation email that can never fail the unlock.
3. **The route** - `app/api/office/account-locks/unlock`, a body ceiling, a JSON parse, three field
   shapes, `readRequestActor`, one service call, one log line, and a response that carries no address.
4. **The catalog string** - `email.accountUnlock.subject`.
5. **The gate** - `checkAccountUnlock()`: four permitted roles, five refused role sets (including
   `owner`), a caller without a second factor, a non-uuid, an unknown id, three closed locks, a lost
   race, a failing audit, an unconfirmed contact, three bad notes, the stored row, the audit payload,
   the effect on `readAccountLock`, an earlier contact instant, the confirmation email in four cases,
   and the exact set of tables the service touches.
6. **UI** - not applicable: the plan gives the management screen to STEP 078.
7. **Security** - the permission check is in the service; the response carries no address; the note is
   the only free text and the audit stores its length; the module writes only `account_locks` and the
   email queue.
8. **Verification** - `node lib/auth/verify.ts` (1 266 checks), `npx tsc --noEmit`, `npm run lint`,
   `npm run verify` (every gate and the production build), the PGlite proof, a live dev probe.

## 5. Acceptance, in the words of the title

- "admin unlock endpoint": `POST /api/office/account-locks/unlock` closes one open lock and answers
  with the account and the instant.
- "with permission check": the four office roles, a satisfied second factor, and a merchant - even the
  owner of the locked company - refused with `403`.
- "and audit entry": exactly one `user.login_unlocked` entry naming the officer, the lock, the factor,
  the window, whether the owner was alerted, and the length of the note.
