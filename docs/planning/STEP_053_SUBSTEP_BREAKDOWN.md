// path: docs/planning/STEP_053_SUBSTEP_BREAKDOWN.md
# STEP 053 - Sub-step breakdown

STEP 053: **Step-up reauthentication guard for sensitive actions**
(`docs/final/STEP_PLAN_250.md` line 700), from `docs/final/FEATURE_LIST.md` section 22 line 236
("Step-up reauthentication is required for gateway keys, payouts, KYC decisions and account
unlocks") and line 244 ("reauthentication for sensitive actions"), with section 6 line 90
("super admin gateway page: super_admin only, with 2FA and fresh reauthentication").

## What is already in place

The two earlier STEPs left the seam, on purpose:

- `sessions.mfa_verified_at` (`0010`) records the instant the second factor was satisfied at sign in,
  and STEP 051 copies it into every rotation, so a family knows how old its own proof is.
- `account-unlock.ts` says in its own header that it is *not* step-up reauthentication, and that
  STEP 053 "adds the prove it again, now requirement on top of the same call" - one function call,
  so the guard has one place to land.
- `/api/office/account-locks/unlock` is the only endpoint of section 22's list that exists yet;
  gateway keys, payouts and KYC decisions arrive in later STEPs, and each will call the same guard.

## What this STEP adds

A **freshness** fact about the session, and a **guard** that reads it:

- `sessions.reauthenticated_at` - when the person last proved the second factor *again*, inside the
  session, without signing in. Null until they do.
- `STEP_UP_WINDOW_MS` (ten minutes) - the age at which a proof stops counting. The instant that
  counts is the later of `reauthenticated_at` and `mfa_verified_at`, so a merchant who signed in with
  their authenticator a minute ago is not asked twice for the same code.
- `POST /api/auth/session/reauth` - the proof: the account's authenticator code, or one of its backup
  codes, verified against the sealed secret in `users`, on a session whose device is confirmed.
- `requireFreshReauthentication` - the guard, one function call in the endpoint.

## Why the second factor and not the password again

The session already proved the password, and the platform's own sign-in keeps a password step and a
code step apart because the second one is the factor a stolen password cannot supply. Asking for the
password again would be the weaker of the two, and it would send a credential through the network a
second time for no new evidence. A backup code is accepted because section 22 built it for exactly
this: a person who still holds their codes but not their app.

## Sub-step 1 - Read the contract

`FEATURE_LIST.md` section 22 lines 236 and 244, `MASTER_PROMPT.md` rules 9 (audit every mutation) and
54 (the audit chain), the STEP 052 handoff's "Next" section, `0010_sessions.sql`,
`0089_session_rotation.sql`, `lib/auth/session-rotation.ts`, `lib/auth/two-factor-login.ts` (the code
verification and its failed-attempt path), `lib/auth/account-unlock.ts` and the unlock route.

## Sub-step 2 - Owned paths

New: `migrations/0091_sessions_reauthenticated_at.sql` (+ rollback; one constraint, no column),
`lib/auth/step-up.ts`,
`app/api/auth/session/reauth/route.ts`, `app/(auth)/reauth/page.tsx` and its client form, this
document and the handoff.

Modified: `lib/auth/session-rotation.ts` (the column, and the rotation copying it),
`lib/auth/types.ts` and `lib/auth/request-actor.ts` (the two freshness facts on the actor),
`lib/auth/session.ts` (the actor a cookie alone produces), `app/api/office/account-locks/unlock/route.ts`
(the guard), `lib/auth/disclosure.ts`, `lib/auth/verify.ts`, `lib/auth/README.md`,
`lib/i18n/strings/en.ts`.

## Sub-step 3 - Database: `0091_sessions_reauthenticated_at.sql`

`0010` already wrote `reauthenticated_at` and its lower bound (`sessions_reauthenticated_check`), so
this STEP adds no column: it adds the **upper** bound that was missing, so a proof can never be
recorded after the row it belongs to has ended. The family ceiling needs no third check, because
`0089` already keeps `expires_at` inside `absolute_expires_at`.

Proof: PGlite, replaying the real `0010` table and the real `0089` ceiling, forward, checks, rollback,
forward again, and two controls - the file that added the column cannot apply at all, and without the
new check a late proof is accepted. That double-add was the defect found and corrected before
STEP 054; `migrations/verify.ts` gained `checkNoRevisions` so no later STEP can repeat it.

## Sub-step 4 - Core service `lib/auth/step-up.ts`

- `readStepUpState(actor, instant)` - pure: the instant that counts, whether it is inside the window,
  and when it stops counting.
- `requireFreshReauthentication(actor, instant?)` - the guard. A stale session answers
  `403 PERMISSION_DENIED` with `{ field: "session", rule: "reauth_required" }`, which a screen can
  tell apart from "this account may not do this at all".
- `reauthSession` - the proof and the write: the session must be live and bound, the device must be
  confirmed (STEP 052), the account must not be locked (section 22's lock still applies), the code
  must verify against the sealed TOTP secret or one of the backup verifiers, a backup code is spent,
  and success stamps `reauthenticated_at` and audits `session.reauthenticated`. A wrong code records
  a failed `totp` attempt through the same recorder the sign in uses, so two wrong codes are a lock
  there too, and answers `422 { field: "code", rule: "invalid_code" }`.

## Sub-step 5 - Wiring

- `POST /api/auth/session/reauth` - bound session, `{code}`, answers `{ status, freshUntilEpochMs }`.
- `/api/office/account-locks/unlock` calls `requireFreshReauthentication` after the proof and the
  trust check, which is the endpoint section 22 names that exists today.
- `lib/auth/disclosure.ts` classifies the route as a session surface.

## Sub-step 6 - UI

`/reauth` - the screen a refused office action sends the person to: what is being asked, the code
field, one button, and a sentence for each refusal. When the session is still fresh the screen says
so instead of asking for a code that would prove nothing.

## Sub-step 7 - Security proof

`checkStepUp()` in `lib/auth/verify.ts`: the pure state, the guard's code and detail, the window's
edges, the rotation carrying the stamp, the route's order (session before body), the unlock route
calling the guard, and the audit entry. Permission, RLS (the session row is service-role only) and
the lock are covered by the existing gates plus the new checks.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/auth/verify.ts`, `node lib/i18n/verify.ts`,
`npm run verify`, the PGlite proof of `0091`, mutation controls, then one commit
`STEP 053: Step-up reauthentication guard for sensitive actions`, pushed to
`arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_053_COMPLETED.md`.
