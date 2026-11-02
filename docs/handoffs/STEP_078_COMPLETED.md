// path: docs/handoffs/STEP_078_COMPLETED.md
# STEP 078 - Account unlock management screen for permitted office roles: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `9fe1b11`. Previous handoff:
`docs/handoffs/STEP_076_COMPLETED.md` (STEP 077 is still outstanding - see "Next").

## STEP

- **Number and title:** STEP 078 - Account unlock management screen for permitted office roles
  (`docs/final/STEP_PLAN_250.md`, the STEP 078 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Last STEP of the block.
- **Feature list:** section 22 - "Login lock: 2 consecutive failed password or failed 2FA attempts lock
  the account for 2 hours... The owner receives an email alert when the lock starts. Unlock is done
  only by an office role with unlock permission and only after contact with the owner is confirmed by
  email. Every unlock is audit logged." - plus section 22's "Step-up reauthentication is required for
  ... account unlocks" and section 23's "account unlock confirmation" mail.
- **Depends on:** STEP 016 (`0012_account_locks.sql` - the lock and its fourteen checks), STEP 046
  (`0086_account_lock_alert.sql`, `lib/auth/lock-alert.ts` - the alert), STEP 047
  (`0087_account_lock_unlock_record.sql`, `lib/auth/account-unlock.ts` and
  `POST /api/office/account-locks/unlock` - the act, its guards and its audit entry), STEP 045
  (`readAccountLock`), STEP 050 (the device proof), STEP 052 (trusted devices), STEP 053
  (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`), STEP 057 (`lib/security/csrf.ts`),
  STEP 068 (the office shell) and STEP 076 (the screen and gate patterns this STEP follows).

## Files

- **Created:** `migrations/0101_account_lock_queue_indexes.sql`,
  `migrations/0101_account_lock_queue_indexes.down.sql`,
  `app/(admin)/account-unlocks/account-locks.ts`, `app/(admin)/account-unlocks/page.tsx`,
  `app/(admin)/account-unlocks/office-unlock-queue.tsx`,
  `components/office/account-unlocks-verify.ts`, `docs/planning/STEP_078_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_078_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `officeUnlock` block and two `office.sectionAccountUnlocks`
  strings), `components/office/navigation.ts` (the twelfth screen, with the role list imported rather
  than restated), `components/office/verify.ts` (twelve screens; the audit and unlock entries' roles
  compared with their registries; the role-namer scan now skips gate files), `lib/auth/verify.ts` (the
  browser mutation baselines: 19 files, 21 call sites), `scripts/verify-shell.mjs` (the client boundary
  check skips `verify.ts` gates).
- **Owned paths touched:** `app/(admin)/account-unlocks/` (new), `components/office/` (navigation and
  two gates), `migrations/0101_*`, plus the copy file a new screen always touches.

## Database

- **One migration, and it is two indexes.**
  - `account_lock_queue_idx` on `public.account_locks (locked_at)`, partial on
    `unlocked_at is null and expired_at is null and deleted_at is null` - the queue an officer works,
    oldest first, which neither `0012` index can serve: `account_locks_live_key` is unique on
    `user_id` (it answers "is this account locked", not "which accounts are locked") and
    `account_locks_expiry_idx` is on `expires_at` for the sweep.
  - `account_lock_recent_idx` on `(unlocked_at desc)`, partial on `unlocked_at is not null` - the
    record beside the queue, so an officer can see a colleague already ended a lock.
  - Both partial on `deleted_at is null`.
- **What this STEP deliberately does not add.** No table, no column, no policy, no data change. The
  role rule is `ACCOUNT_UNLOCK_OFFICE_ROLES` plus a satisfied second factor, enforced in the module with
  the same two functions `unlockAccountLock` uses; `account_locks` keeps `default_deny` and is read
  through the service role client exactly as STEP 047 writes through it.
- **Rollback:** `0101_account_lock_queue_indexes.down.sql` drops exactly the two indexes and leaves
  `0012`'s two, so the schema returns to the state STEP 076 shipped.
- **Migration number after this STEP:** `0102` is free.

## Environment

- No new variable. The screen reads through the authentication runtime, which already validates the
  seven boot variables.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
- **Package requests still open for the owner:** `check:account-unlocks`
  (`node components/office/account-unlocks-verify.ts`), `check:audit-log`, `check:announcements`,
  `check:settings`, `check:countries`, `check:approvals`, `check:office`, `check:auth`,
  `check:security`, `check:gateways`, `check:permissions`.

## What was built

- **`app/(admin)/account-unlocks/account-locks.ts`** - `ACCOUNT_LOCK_QUEUE_LIMIT` (50),
  `ACCOUNT_LOCK_RECENT_LIMIT` (20), `ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH` (imported from STEP 047's 280),
  `ACCOUNT_LOCK_FACTORS` (`password`, `totp`); `lockStandingOf` and `remainingSecondsOf` (both fail
  closed on an unreadable expiry); `lockFactorLabelKey` and `lockStandingLabelKey`; and
  `listAccountLocks`, which asks `requireAnyRole(ACCOUNT_UNLOCK_OFFICE_ROLES)` and
  `hasSatisfiedTwoFactor` before its first query, reads the open locks oldest first, the last twenty
  closures newest first, and one read of `users` for the accounts on the page.
- **`app/(admin)/account-unlocks/page.tsx`** - the five answers, the queue with its count and read
  instant, the record of office closures as a table, and the home link. It holds no role list: the
  refusal it prints is the service's `PERMISSION_DENIED`.
- **`app/(admin)/account-unlocks/office-unlock-queue.tsx`** - the rows (account, identifier, factor,
  locked at, open until, wait left, owner alert, contact) and one panel that takes a note of at most
  280 characters, the contact confirmation, and one POST to STEP 047's route with the device proof and
  the CSRF token; `403` with `reauth_required` is told apart from `403` without it and links to
  `/reauth`; `409`/`404` say somebody else closed the row; `422` names the note or the confirmation;
  after a success it asks the server for the queue it just changed.
- **`components/office/navigation.ts`** - the twelfth screen at `/account-unlocks`, roles imported
  from `ACCOUNT_UNLOCK_OFFICE_ROLES`.
- **`components/office/account-unlocks-verify.ts`** - the gate.

## Behaviour Proof (acceptance checklist)

- **Four roles read, and the rest are refused before any query.** `super_admin`, `ceo`,
  `compliance_kyc` and `support` read the queue; `finance_ops`, `blogger`, `owner`, an account with no
  role, an officer who has not enrolled a second factor and one that still owes it are refused with
  `PERMISSION_DENIED` - the gate asserts the query count stays zero for each.
- **The queue is every open lock, oldest first.** Three rows come back in `locked_at` order; the
  PostgREST string is asserted to carry `unlocked_at=is.null&expired_at=is.null&deleted_at=is.null`,
  `order=locked_at.asc` and `limit=50`.
- **The record is the unlocked set, newest first,** with `unlocked_at=not.is.null`,
  `order=unlocked_at.desc`, `limit=20`, and the note and the officer's identifier printed.
- **A lapsed row is shown and never offered.** A lock whose `expires_at` has passed reports standing
  `lapsed`, `remainingSeconds` 0 and `unlockable` false - the screen prints "the time is up" instead of
  a button, because `unlockAccountLock` refuses that row with `CONFLICT`.
- **The wait is honest.** 5,400 seconds prints as 90 minutes, 30 seconds prints as "under a minute",
  and an unreadable expiry prints nothing that suggests the lock is open.
- **The account is reachable.** The page joins `users` for the address and the name, because section 22
  unlocks only after contact with the owner by email; an account whose row is gone is still listed by
  its identifier rather than dropped.
- **The screen reads and never writes.** The store the gate runs over records every write it is asked
  for and all of them stay empty; the module's source is checked for a call to `unlockAccountLock(`,
  which is absent.
- **The act is STEP 047's, with its guards.** The gate asserts one console path constant
  (`/api/office/account-locks/unlock`), that the console spreads the device proof and the CSRF token,
  that the path holds exactly one route on disk, and that the route carries `requireCsrfToken(`,
  `verifySensitiveRequest(`, `requireTrustedDevice(` and `requireFreshReauthentication(` before
  `unlockAccountLock(`.
- **Every sentence is in the catalog, both ways.** Every `officeUnlock.*` key the code names exists, and
  every key the catalog holds is printed somewhere.

## Security proof

- **The rule is one rule.** The screen asks the same two questions as the act, with the same two
  functions, before its first query; no file in the screen names a role (`super_admin` appears in
  `components/office/navigation.ts` alone, which the office gate proves over the whole tree).
- **No new way in.** There is no route in this STEP: the console posts to the STEP 047 endpoint, which
  already requires the CSRF token, the device proof, a trusted device and a fresh reauthentication.
- **The note is bounded and never echoed.** 280 characters, enforced in the module (from the column),
  in the textarea (`maxLength` from the same constant) and in `0087`; the audit entry records its
  length rather than its text, and the screen prints it only from the row the database holds.
- **Nothing secret is read.** The account join selects `id`, `email` and `full_name` - the three facts
  the officer needs to reach the owner - and no other column of `users`.
- **A closed lock cannot be reopened from here.** The module writes nothing, and the screen offers no
  control on a row in the record.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node components/office/account-unlocks-verify.ts` - **account unlock gate passed: 498 checks, 4
  unlock roles, 50 open locks a queue** (new).
- `node components/office/verify.ts` - **544 checks, 6 office roles, 12 screens, 7 roles decided** (was
  526 / 6 / 11 / 7).
- `node lib/auth/verify.ts` - 2455 checks, cookie `__Host-kd_session`, 8 chunk ceiling (the browser
  mutation baselines moved to 19 files and 21 call sites).
- `node lib/security/verify.ts` - 2376 checks.
- `node lib/audit-log/verify.ts` - 735 checks.
- `node lib/settings/verify.ts` - 551 checks; `node lib/announcements/verify.ts` - 351 checks.
- `node lib/approvals/verify.ts` - 536 checks; `node lib/gateways/verify.ts` - 467 checks;
  `node lib/countries/verify.ts` - 467 checks; `node lib/permissions/verify.ts` - 425 checks;
  `node lib/jobs/verify.ts` - 110 checks.
- `npm run check:migrations` - **2942 checks, 101 migrations, 76 tables** (was 2922 / 100 / 76).
- `npm run check:i18n` - **997 messages, 84 placeholders, 1 locale** (was 938 / 76).
- `npm run check:structure` - 17 directories, 14 root files, **244 source files** (was 240).
- `npm run check:shell` - **370 checks, 93 files** (was 357 / 89).
- `npm run check:env`, `check:config`, `check:logger`, `check:errors`, `check:lint`, `check:jobs` -
  green.
- `npm run build` - compiles; `/account-unlocks` is dynamic beside the other office screens.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders) and
  `npm run dev -- --port 3105`, `/account-unlocks` answered `307` to `/signin` for an anonymous
  visitor, `/audit-log` and `/admin` still answered `307`, and
  `POST /api/office/account-locks/unlock` answered `422 VALIDATION_FAILED` with
  `{field: "csrf", rule: "csrf_token_invalid"}` - the guard refusing before the body is read.
- `npm run verify` - the whole sweep above, exit 0.

## Known limitation, recorded rather than hidden

- **A signed in pass was not exercised in this sandbox.** There is no browser, no session and no
  PostgREST project here, so the behaviour proof is the gate's over the real service code; the
  deployment checks below are the pass a person runs against a seeded project.
- **The queue reads the platform's clock once.** "Minutes left" is computed when the page is rendered,
  so it does not tick down; a page left open for an hour shows the wait it showed when it was read,
  which is why the read instant is printed beside the count.
- **Fifty open locks is a cap, not a count.** A queue longer than that is an incident; the screen prints
  how many rows it shows. A paged queue belongs to the STEP that needs one - STEP 076's offset window
  is the pattern.
- **The record shows only office closures.** A lock the clock ended is not listed: it was never an
  office decision, and `expired_at` is the sweep's business. An officer who needs that history reads
  the audit log.
- **The account join is by identifier and nothing else.** No email search and no account picker: the
  screen answers "who is locked", not "find an account", because a search over merchants is a different
  permission from unlocking one.
- **`unlock_note` is printed to every permitted role.** It is the officer's record of what they
  verified, and section 22 makes it part of the act; the four roles that may unlock are the four that
  may read it.

## Deployment checks a person runs

1. Confirm `0101` is applied: `pg_indexes` lists `account_lock_queue_idx` and
   `account_lock_recent_idx`, both partial, and `0012`'s `account_locks_live_key` is still unique.
2. Lock an account by signing in with two wrong passwords, or seed two `login_attempts` failures and
   one open `account_locks` row. The owner's lock alert is queued by STEP 046.
3. Sign in as `support` and open `/account-unlocks`: the row is there, oldest first, with the account's
   address, the factor that locked it, the wait left and whether the owner was told.
4. Press the unlock button, write a note of what you verified, leave the confirmation checkbox clear
   and submit: the screen answers "confirm the contact first" and nothing is written.
5. Tick the confirmation and submit: `account_locks` gains `owner_contact_confirmed_at`, `unlocked_at`,
   `unlocked_by` and `unlock_note`; one `user.login_unlocked` entry is on the audit trail with the note's
   length; the row moves to the record below; a row in `email_send_logs` holds the section 23
   confirmation; and the account can sign in again.
6. Seed a lock whose `expires_at` has passed but whose row nobody closed: the screen shows it as "Time
   is up" and offers no button.
7. Sign in as `finance_ops` and then `blogger`: no sidebar entry, and `/account-unlocks` shows the
   refusal.
8. Open `/account-unlocks` at 375 pixels wide: the cards stack, the record table scrolls inside its
   frame, and the panel's textarea and checkbox are reachable by keyboard.
9. Section 22's freshness guard: wait out the step-up window (`STEP_UP_WINDOW_MS`), then unlock. The
   route answers `403` with `reauth_required`, and the screen prints the sentence with the link to
   `/reauth`.

## Next

- **STEP 077 is still outstanding.** The archive's order is 077 (session management screen with revoke
  actions) before 078, and this session was asked for 078 directly. Everything 077 needs already
  exists - `lib/auth/session-list.ts` with `SESSION_MANAGEMENT_OFFICE_ROLES` and the revoke service of
  STEP 054, plus the `/api/office/sessions/revoke` route with its guards - and the screen it needs is
  `app/(admin)/sessions/`, a thirteenth sidebar entry. Nothing in this STEP blocks it; the shell, the
  console pattern and the gate pattern are the three things it will copy.
- **STEP 079** (merchant onboarding wizard shell) starts the next block and is owned by
  `app/(dashboard)/onboarding/`, which does not exist yet.
- The seams this STEP leaves: `app/(admin)/account-unlocks/account-locks.ts` is the shape a queue takes
  when the act already exists elsewhere - read, refuse with the act's own two questions, offer a
  control only where the service would accept it; `office-unlock-queue.tsx` is the console pattern for
  a per-row act with a single panel (`app/(admin)/countries/country-switch-console.tsx` is the same
  shape for a single subject); and `lockStandingOf` is the naming a row gets when the database has no
  column for what a person sees.
