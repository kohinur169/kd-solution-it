// path: docs/handoffs/STEP_046_COMPLETED.md
# STEP 046 Completed - Handoff

Feature: **owner email alert when a login lock starts** (`docs/final/STEP_PLAN_250.md` line 616),
from `docs/final/FEATURE_LIST.md` section 22 (LR-022): "The owner receives an email alert when the
lock starts." Commit: `STEP 046: Owner email alert when a login lock starts`.

## What was delivered

1. **The lock now points at the email it raised.** `0086` adds `account_locks.alert_send_id`, a
   foreign key to `email_send_logs`, a check that an alerted lock names its email, and a unique
   partial index that keeps the link one to one. A lock that alerts the owner twice is not a state the
   database accepts.
2. **`lib/auth/lock-alert.ts`** - `createLockAlertNotifier` runs once per lock that starts: it reads
   the open lock, refuses to alert twice, reads the sending method the office made active in
   `email_settings` (`0059`), resolves the company owner (`role_assignments` with `role = 'owner'`,
   joined to `users.email`), writes one `email_send_logs` row (`0061`) with
   `template_key = 'login_lock_alert'`, and stamps the lock.
3. **One alert per lock, claimed in the database.** The claim is
   `update account_locks set alert_send_id = ..., owner_alerted_at = ... where id = ... and
   alert_send_id is null`, read back afterwards; a call that lost the race marks its own queue row
   `dropped` with the reason "The lock already alerted its owner.". One email, and a log that tells
   the truth about both calls.
4. **Nothing about a mail problem touches the lock.** `LockAlertOutcome` is a value, never an
   exception: `queued`, `already_alerted`, `no_lock`, `no_owner`, `sender_not_configured`, `failed`.
   `recordFailedSignIn` catches the whole lock step, the notifier logs every non-queued outcome for an
   operator, and the stranger still reads the refusal they had already earned.
5. **Both factors alert.** `signInMerchant` (two wrong passwords) and `completeTwoFactorChallenge`
   (two wrong codes) pass the notifier through, so a lock opened by either factor emails the owner
   once, with the factor named in the audit entry.
6. **Audited, without the address.** `user.login_lock_alerted` records `send_id`, `template_key`,
   `triggered_by`, `failed_attempts`, `locked_at`, `locked_until` and `recipient: "owner"`. The
   address is in the queue row where it is needed to send, and is deliberately not in the immutable
   chain.
7. **The subject is a catalog string.** `email.lockAlert.subject` in `lib/i18n/strings/en.ts`; the
   service contains no English sentence of its own.

## State before the first edit

No pre-existing defect was open at `5e35b0a`: the working tree was clean, `HEAD` matched
`origin/arena/1dc51ec3-kd-solution-it`, and `npm run verify` plus `node lib/auth/verify.ts` were green.
The correction this STEP had to make was to its own reconnaissance, not to the repository: the email
tables do exist (`0059`-`0061`) and `login_lock_alert` is already a legal template key, so no new
table was written.

## Design notes worth keeping

- **The queue is `0061`, not a new outbox.** `email_send_logs` already carries the template key, the
  recipient, the status walk (`queued -> sent | failed | dropped`), attempts, `max_attempts`, the
  retry instant and `reference_kind = 'account'`. A new table would have been a second truth about
  what the owner was told.
- **This STEP sends nothing, on purpose.** The plan gives the email system to STEP 221-230
  (`lib/email/`, SMTP and API configuration, the template editor, the retry sweep) and the plan's
  section 23 owns the transport. STEP 046 ends where that system begins: one queued row with the
  sending method 221 configures.
- **`owner_alerted_at` means "the platform took responsibility for telling the owner"**, not "the
  provider accepted it". Delivery lives in one place - `email_send_logs.status`, `sent_at`,
  `attempts`, `provider_message_id` - and `0061`'s guard already freezes the parts of a send that must
  never change. Copying delivery state onto the lock would have been a second truth.
- **No owner, no sender, no email - and still a lock.** A platform account has no merchant owner; a
  fresh deployment has no active `email_settings` row until STEP 221 runs. Both are answers with a log
  line, not reasons to fail a sign in.
- **The alert is asked for at the lock, not at every failure.** The call sits after the audit entry of
  `user.login_locked`, inside the branch that created the row, so a third failure of an already locked
  account asks for nothing.
- **The address is resolved from a role, never from the request.** The owner comes from
  `role_assignments`, so no input on the sign in path can redirect an alert.

## Migration and its proof

`migrations/0086_account_lock_alert.sql` / `.down.sql`, one transaction each.

- forward: column, FK, a backfill that recovers the pointer for locks already marked alerted (so the
  file can be applied again after its own rollback), the pair check, the unique partial index, and the
  comments the next reader needs;
- down: drops the index, both constraints and the column, keeps every row of `account_locks` and
  `email_send_logs`.

PGlite proof (`proof86.mjs`, PGlite 0.5.14): **30 checks** over five separate databases - the shape of
the change, `alert_send_id` unique and partial, the lock and its email reading back as one answer, the
rollback over a table with alerts, the re-apply recovering the pointer from the send log, an alerted
lock without a send being refused (`account_locks_alert_pair_check`), a send that does not exist being
refused (`account_locks_alert_send_fkey`), two locks sharing one email being refused
(`account_locks_alert_send_key`), and an alerted lock whose email is taken away being refused.
Negative controls: with the pair check replaced by `true` the proof failed on exactly that check; with
the unique index removed it failed on the index. Both restored before the commit.

## Verification

- `node lib/auth/verify.ts`: **1 162 checks** (1 098 before this STEP). `checkLockAlert()` proves the
  six outcomes, the race, the silent queue, the audit entry, the subject coming from the catalog, and
  that a notifier which rejects cannot stop a lock.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **128 source files**, config 10
  sections / 28 values, i18n **204 messages / 8 placeholders**, logger 117, errors 202 checks / 15
  codes, lint 77 checks / 26 rules, shell 174 checks / 35 files, jobs 110 checks, migrations **2 515
  checks / 86 migrations / 72 tables**, type check, lint, production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency.
- Negative controls on the new checks: removing the idempotency read failed "the second call writes no
  second email"; alerting a failure that opens no lock failed three checks including "one failure
  alerts nobody". Both restored.
- Live probe on port 3000 (server stopped afterwards): `GET /signin` 200, `GET /2fa` 200,
  `POST /api/auth/signin` with a malformed body `401 AUTHENTICATION_REQUIRED`, with a well formed body
  `502 DEPENDENCY_FAILED` from the first database read (this sandbox has no Supabase project). The
  alert itself is therefore proven by the gate and the PGlite proof rather than over HTTP here.

## Behaviours of the title, exercised

1. **A lock that starts queues one email.** One call, one `email_send_logs` row with
   `template_key = 'login_lock_alert'`, the active sending method, the owner's address, and
   `reference_kind = 'account'` with the locked account.
2. **The owner is the company owner.** A platform account (`company_id` null) answers `no_owner`; a
   company whose owner assignment was revoked answers `no_owner`; neither writes an email.
3. **One alert per lock.** The second call for the same lock answers `already_alerted` and writes
   nothing; a third failed sign in asks for no alert at all.
4. **A losing race sends one email.** The losing call's row is `dropped` with a reason, and the lock
   is stamped by the winner only.
5. **A mail outage is not a sign in outage.** With a notifier that rejects, the lock row still exists,
   `opened` is true, the route still answers 423, and the failure is logged.
6. **The second factor alerts too.** Two wrong codes queue the alert with `triggered_by = "totp"`.
7. **Nothing leaks to the stranger.** The alert happens after the password, the address never appears
   in an audit payload or a log line, and the response body is unchanged from STEP 045.

## Corrections to earlier statements

- STEP 045's handoff said the retry sweep would find an unsent alert by `owner_alerted_at is null`.
  That is not how this STEP built it: `owner_alerted_at` is written when the email is queued, and the
  sweep of STEP 227 reads `email_send_logs.status = 'queued'` with `next_retry_at`, which is what
  `0061` already indexes. `account_locks.alert_send_id` is the join from a lock to its email; there is
  no second "owed" queue on the lock.

## UI

Not applicable for this STEP, and deliberately so: section 22 asks for an email to the owner, and the
sign in screen already explains the lock and the office contact rule (STEP 045). A screen that shows
whether the owner was told, and whether the provider accepted it, belongs with the office unlock of
STEP 047, which is where `alert_send_id` and `email_send_logs.status` are worth showing.

## Package request (still open)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.
- STEP 046 adds **no dependency**. The mail transport (for example `nodemailer`) belongs to STEP 221,
  which owns `lib/email/` and the SMTP configuration screen.

## Seams for the next STEPs

- **047 (admin unlock with permission check and audit):** `account_locks.alert_send_id` and
  `owner_alerted_at` answer "was the owner told, and with which email"; join `email_send_logs` on
  `alert_send_id` for the delivery status. `owner_contact_confirmed_at`, `unlocked_at`, `unlocked_by`
  and `unlock_note` are still untouched by this STEP, and `assertAccountUnlocked` remains the read
  side.
- **048 (generic auth errors):** `ACCOUNT_LOCKED` is still reachable only after the password, and the
  alert changes no response. The audit action added here is server side only.
- **221-224 (email configuration, templates):** once `email_templates` has a `login_lock_alert` row the
  sender renders the body from it; the queued subject stays the catalog string
  `email.lockAlert.subject` copied at queue time, and STEP 224 may revisit that if the office wants to
  edit subjects in the log.
- **227 (retry sweep):** `email_send_logs.status = 'queued'` with `next_retry_at` is the work list; a
  row goes `sent` with `sent_at` and `provider_message_id`, or `failed` with `failure_reason` and a
  retry instant, or `dropped` when it must not be sent. `max_attempts` is frozen at queue time here to
  `LOCK_ALERT_MAX_ATTEMPTS = 3`.
- **Password reset and office screens:** a lock whose company has no live owner assignment is a state
  the office should be able to see and fix; the query is `role_assignments` with `role = 'owner'` and
  `revoked_at is null` per company.
