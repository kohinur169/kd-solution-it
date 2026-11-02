// path: docs/planning/STEP_078_SUBSTEP_BREAKDOWN.md
# STEP 078 - sub-step breakdown

STEP: **Account unlock management screen for permitted office roles** (FEATURE_LIST section 22, the
unlock sentences: "Unlock is done only by an office role with unlock permission and only after contact
with the owner is confirmed by email. Every unlock is audit logged.", plus section 22's step-up line
and section 23's "account unlock confirmation"; STEP_PLAN_250 section 078).

The STEP is one screen over a table that already exists and an act that already exists, so it is cut
into five sub-steps in the order the work is verifiable rather than the order it is described.

## Sub-step 1 - read what already exists, and decide what the database is missing

- `0012_account_locks.sql`: the lock, its fourteen checks, the one open lock per account
  (`account_locks_live_key`), the expiry sweep index and `default_deny`.
- `0086_account_lock_alert.sql`: the alert that went to the owner, and the row that records it.
- `0087_account_lock_unlock_record.sql`: an office unlock carries the note of what the officer
  verified.
- `lib/auth/account-unlock.ts` (STEP 047): `ACCOUNT_UNLOCK_OFFICE_ROLES`, the 280 character note, the
  contact confirmation, the audit entry `user.login_unlocked`, the section 23 confirmation mail - and
  the route `POST /api/office/account-locks/unlock` that carries the CSRF token, the device proof and
  the fresh reauthentication.
- Conclusion: no table, no column, no policy, and no second endpoint. Two access paths are missing -
  "every open lock, oldest first" and "what the office closed most recently" - so `0101` adds two
  partial indexes and nothing else.

## Sub-step 2 - the migration and its rollback

- `migrations/0101_account_lock_queue_indexes.sql`: `account_lock_queue_idx` on `(locked_at)` partial
  on the open set, and `account_lock_recent_idx` on `(unlocked_at desc)` partial on the unlocked set.
- `migrations/0101_account_lock_queue_indexes.down.sql`: drops exactly those two, leaves `0012`'s.
- `npm run check:migrations`.

## Sub-step 3 - the queue module

- `app/(admin)/account-unlocks/account-locks.ts`: the two lists, the account join that makes the
  owner reachable, the standing (`open` or `lapsed`) that decides whether a button is offered, the
  remaining seconds, the label keys, and the guard - `requireAnyRole(ACCOUNT_UNLOCK_OFFICE_ROLES)` and
  `hasSatisfiedTwoFactor`, the same two questions `unlockAccountLock` asks, asked before the first
  query.
- No writer: the act belongs to STEP 047 and this module never calls it.

## Sub-step 4 - the copy

- `lib/i18n/strings/en.ts`: the `officeUnlock` block (about sixty strings) and
  `office.sectionAccountUnlocks` with its description.
- `npm run check:i18n`.

## Sub-step 5 - the screen, the console, the sidebar and the gates

- `app/(admin)/account-unlocks/page.tsx`: the five answers, the queue, the record of closures, and the
  home link.
- `app/(admin)/account-unlocks/office-unlock-queue.tsx`: the rows with their facts, and one panel that
  takes a note, a confirmation and one POST to STEP 047's route - device proof, CSRF token, the
  reauthentication window told apart from a plain refusal.
- `components/office/navigation.ts`: the twelfth screen, with `ACCOUNT_UNLOCK_OFFICE_ROLES` imported
  rather than restated.
- `components/office/verify.ts`: eleven screens become twelve, and the role-namer scan stops reading
  gate files, whose fixtures spell the roles to prove that one file in the tree does.
- `lib/auth/verify.ts`: the browser mutation baselines move from 18 / 20 to 19 / 21, because this
  screen is one more browser file that mutates.
- `scripts/verify-shell.mjs`: the client boundary check skips `verify.ts` gates, whose scan strings are
  not code that could reach a browser bundle.
- `components/office/account-unlocks-verify.ts`: the gate.
- `npm run verify`, the dev smoke, one commit and the handoff.

## What this STEP deliberately leaves out

- **No second endpoint.** Unlock is `POST /api/office/account-locks/unlock` of STEP 047, with the
  guards it already carries. A screen-specific route would be a second way in with a weaker guard.
- **No counter reset.** Section 22 lists exactly what clears a lock - an office unlock after contact,
  or the clock. Unlocking touches no `login_attempts` row; the next successful sign in ends the streak.
- **No edit of a closed lock.** A closure is mutually exclusive with the clock and is the record of who
  ended a lock; the second list is read-only by construction.
- **No step-up button.** Section 22's freshness is STEP 053's guard on the route; the screen offers the
  `/reauth` link when the route says the window has passed.
