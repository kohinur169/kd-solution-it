// path: docs/handoffs/STEP_047_COMPLETED.md
# STEP 047 Completed - Handoff

Feature: **admin unlock endpoint with permission check and audit entry**
(`docs/final/STEP_PLAN_250.md` line 628), from `docs/final/FEATURE_LIST.md` section 22 (LR-022).
Commit: `STEP 047: Admin unlock endpoint with permission check and audit entry`.

## What was delivered

1. **`POST /api/office/account-locks/unlock`** closes one open lock: body
   `{ lockId, note, ownerContactConfirmed }`, and it answers `{ status: "unlocked", userId,
   unlockedAt }` with `cache-control: no-store`. The route is a boundary only - body ceiling 4 KiB,
   JSON parse, three field shapes, the actor from the session cookie, one service call, one log line.
2. **`lib/auth/account-unlock.ts`** - `unlockAccountLock` is where the decisions are, so the screen of
   STEP 078 and the step-up guard of STEP 053 cannot get a weaker version by calling the service.
3. **The permission check.** `ACCOUNT_UNLOCK_OFFICE_ROLES` is `super_admin`, `ceo`, `compliance_kyc`
   and `support`, enforced by `requireAnyRole`; the actor must also have answered a second factor
   (`hasSatisfiedTwoFactor`), because section 22 makes TOTP mandatory for every role holding account.
   A merchant - including the owner of the locked company - is `403 PERMISSION_DENIED`, and so are
   `finance_ops`, `blogger`, `client` and an empty role list.
4. **The contact and the record.** The caller must confirm the owner was reached, and the update stamps
   `owner_contact_confirmed_at`, `unlocked_at`, `unlocked_by` and `unlock_note` in one conditional
   write. `0012`'s contact check is unchanged and now actually exercised; `0087` closes the one gap
   left - an unlock without a note.
5. **The audit entry.** `user.login_unlocked`, one per unlock, naming the officer (`actorUserId`), the
   account (`entityId`), the company, and the lock: `lock_id`, `triggered_by`, `locked_at`,
   `expires_at`, `owner_alerted`, `owner_contact_confirmed_at`, `lock_age_seconds`, `note_length`.
   The note's text stays on the row; the immutable chain gets its length.
6. **The confirmation email.** Section 23 lists "account unlock confirmation" among the automatic
   emails, so one `email_send_logs` row is queued with `template_key = 'account_unlock'` to the address
   of the account that was locked, using the active sending method of `email_settings`. Best effort and
   caught: no sender, no address and a refusing queue are logged answers, and never a failed unlock.
7. **The refusals a caller can earn.** `404` for an id that is not shaped like one and for a lock that
   does not exist; `409` for a lock already unlocked, already expired, or past its two hours even when
   its row was never closed, and for a lost race with a second officer; `422` for a missing contact
   confirmation, an empty note, a note past 280 characters, or a body that is not the right shape;
   `403` for the wrong role or an unproven second factor.

## State before the first edit

No pre-existing defect: clean tree at `7f43487`, `HEAD` equal to `origin/arena/1dc51ec3-kd-solution-it`,
and every gate green. The one gap the STEP had to fix is in the schema, not the code: `0012` allowed an
unlock with `unlock_note` null, which is why this STEP carries a migration at all.

## Design notes worth keeping

- **The permission check belongs to the service.** A route-level check is a check that a second route
  can forget; STEP 078's screen and STEP 053's guard will call this function, not the endpoint.
- **One call, not two.** `0012` keeps a single text column for the officer's record, so a "record the
  contact" action followed by an "unlock" action would overwrite the first record with the second. The
  confirmation is an explicit field, the contact instant is a column, and the note is required by the
  database - three witnesses for one sentence.
- **The row decides the race.** The write is `update ... where unlocked_at is null and expired_at is
  null`; the read back turns a lost race into `409` instead of a success that never happened.
- **A lock the clock already ended is a conflict, not a no-op.** `readAccountLock` ignores a row past
  `expires_at`, so writing `unlocked_at` on it would record an unlock that changed nothing.
- **The audit is after the row and uncaught.** Section 22 says every unlock is logged; an unlock the
  platform cannot record has to surface to the officer, and the gate proves the row is already closed
  when that happens, so the next caller sees the state instead of repeating the action.
- **The confirmation email is queued last and caught.** The merchant hears about an unlock that did
  happen, never about one that did not.
- **Nothing else is written.** The module touches `account_locks` and the email queue. It never writes
  `users` and never writes `login_attempts`: the streak that caused the lock stays as history, and the
  next successful sign in is what ends it. Section 22 lists two ways out of a lock; this STEP adds no
  third.

## Migration and its proof

`migrations/0087_account_lock_unlock_record.sql` / `.down.sql`, one transaction each: the constraint
`account_locks_unlock_record_check` added `not valid` and then validated, plus its comment; the
rollback drops the constraint and keeps every row.

PGlite proof (`proof87.mjs`, PGlite 0.5.14): **24 checks** over four databases - the rule exists and is
validated, an unlock with a note is accepted and stores the officer and the note, an unlock cannot be
left without a note, the rollback drops the rule and keeps the row, a re-apply is refused over a
note-less unlock and applies once the row is in order, `0012`'s contact check still refuses an unlock
without a contact, a note-less unlock written before the rule blocks the migration, and the clock still
closes a lock without any note. Negative controls: with the rule replaced by `true` the proof failed on
the note checks; with the `validate constraint` line removed it failed on `convalidated`. Restored.

## Verification

- `node lib/auth/verify.ts`: **1 266 checks** (1 162 before this STEP), including the new
  `checkAccountUnlock()`.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **130 source files**, config 10
  sections / 28 values, i18n **205 messages / 8 placeholders**, logger 117, errors 202 checks / 15
  codes, lint 77 checks / 26 rules, shell 176 checks / 36 files, jobs 110 checks, migrations **2 535
  checks / 87 migrations / 72 tables**, type check, lint, production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency.
- Negative controls on the new checks, each restored afterwards: adding `owner` to the permitted roles
  failed the role checks; removing the contact-confirmation guard failed two checks; removing the
  second-factor guard failed two; removing the expiry guard failed two; removing the read-back failed
  two; removing the queue's `catch` failed two. Every one of them fired.
- Live probe on port 3000 (server stopped afterwards): `POST /api/office/account-locks/unlock` with no
  session answers `401 AUTHENTICATION_REQUIRED`; with a malformed body `422 VALIDATION_FAILED` and the
  two field details; with a declared length over 4 KiB `413 PAYLOAD_TOO_LARGE`; `GET` answers `405`;
  the office queue page still answers 200. This sandbox has no Supabase project, so no unlock can be
  exercised over HTTP here - the service is proven by the gate, which is where the permission and the
  audit live.

## UI

Not applicable for this STEP, and deliberately so: the plan gives "account unlock management screen for
permitted office roles" to STEP 078. That screen needs two things this STEP deliberately did not build:
a read of the open locks (a `GET` beside this endpoint, or a listing in the 078 route) and a place to
show `alert_send_id` / `email_send_logs.status`, so an officer can see whether the owner was told and
whether the provider accepted the email.

## Package request (still open)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`. STEP 047 adds **no dependency** either.

## Seams for the next STEPs

- **048 (generic authentication errors):** the unlock adds no response a stranger can reach. Its
  `403`/`404`/`409` are office-only answers behind a session and a role, and reveal nothing about an
  address.
- **053 (step-up reauthentication):** the guard belongs in front of `unlockAccountLock`, whose input is
  the actor plus three fields - one call site, one place to require a fresh proof.
- **055 (rate limiting):** this endpoint is a mutation by an office role; it belongs on the same list
  as the other office actions when the limiter lands.
- **078 (management screen):** reads open locks, calls this endpoint, and shows
  `owner_alerted_at`/`alert_send_id` with the send log's status. It must not re-implement the
  permission check.
- **221-227 (email system):** the confirmation row is queued here with `max_attempts = 3` and
  `reference_kind = 'account'`; STEP 227's sweep sends it, and STEP 224 owns the editable body of
  `account_unlock`.
- **Password reset:** section 22 disables reset during a lock; `assertAccountUnlocked` is the one call
  that sentence needs, and an unlock closes the row, so reset works again immediately afterwards.
