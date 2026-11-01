// path: docs/handoffs/STEP_053_COMPLETED.md
# STEP 053 completed - Step-up reauthentication guard for sensitive actions

Branch `arena/1dc51ec3-kd-solution-it`, base `a19c08c` (STEP 052).
Source: `docs/final/STEP_PLAN_250.md` line 700; `docs/final/FEATURE_LIST.md` section 22 line 236
("Step-up reauthentication is required for gateway keys, payouts, KYC decisions and account
unlocks"), line 244 ("reauthentication for sensitive actions") and section 6 line 90 ("super admin
gateway page: super_admin only, with 2FA and fresh reauthentication").

## What the STEP asks for

Section 22 names four actions a session alone may not perform, and line 244 puts reauthentication
among the session protections beside the rotating token and the new device check. Section 6 asks for
the same thing on the gateway page, which does not exist yet.

Of the four, one endpoint exists: `POST /api/office/account-locks/unlock`. Gateway keys, payouts and
KYC decisions arrive in later STEPs, and each will call the same guard - which is why this STEP built
the guard as one function and one column rather than as a rule inside the unlock route.

## Sub-steps, in order

1. **Read the contract** - section 22 lines 236 and 244, section 6 line 90, `0010`, `0089`, the
   STEP 052 handoff's "Next", `session-rotation.ts`, `two-factor-login.ts` (the code verification and
   its failed-attempt path) and `account-unlock.ts`, whose header says in its own words that STEP 053
   adds "the prove it again, now requirement on top of the same call".
2. **Owned paths**, recorded in `docs/planning/STEP_053_SUBSTEP_BREAKDOWN.md` before any code.
3. **Schema** - `migrations/0091_sessions_reauthenticated_at.sql` and its rollback.
4. **Service** - `lib/auth/step-up.ts`.
5. **Wiring** - the route, the actor's two freshness facts, the disclosure table, the unlock guard.
6. **Screen** - `/reauth` and its client form.
7. **Security proof** - `checkStepUp()` and the mutation controls below.
8. **Gates, commit, push, handoff** - this document.

## Database - `0091_sessions_reauthenticated_at.sql`

`0010_sessions.sql` already carried the column this STEP needs - `reauthenticated_at`, together with
`sessions_reauthenticated_check`, which refuses an instant that predates `issued_at`. What it did not
bound is the other end. `0091` is that bound and nothing else:

| object | where | meaning |
| --- | --- | --- |
| `sessions.reauthenticated_at` | `0010` | when this session last proved the second factor again; null until it does |
| `sessions_reauthenticated_check` | `0010` | a proof cannot predate `issued_at` |
| `sessions_reauthenticated_within_row_check` | `0091` | a proof cannot reach past the row's `expires_at` |

The family's `absolute_expires_at` needs no third check: `0089` already refuses a row whose
`expires_at` is past it, so a proof inside the row is inside the ceiling by construction. That is
written into the migration rather than left as an apparent omission, and the proof states the
boundary case explicitly.

Additive: no column, no row and no existing constraint is touched, so deploying this file
invalidates no session. The rollback drops the one check and keeps the column, the lower bound and
every row.

Proof: PGlite 0.5.14 against the **real** `0010` table definition and the **real** `0089` ceiling,
not a hand written stand-in - forward, 17 checks, rollback, forward again, plus two controls: the
version of this file that first shipped (which added the column `0010` already had) cannot apply at
all, and without the new check a proof past the row's end is accepted.

### Correction, made before STEP 054

The first version of `0091` added `reauthenticated_at` as a new column. It never ran anywhere - the
migrations gate is static and the proof of that STEP used a hand written `sessions` table - so the
duplicate surfaced only when STEP 054 re-read `0010`. It is corrected here rather than in a later
migration, because a migration that cannot apply on a real database cannot be repaired by one that
runs after it. Two things changed with it:

- the PGlite proof now replays the real `0010` and `0089` files instead of a stand-in;
- `migrations/verify.ts` gained `checkNoRevisions`, which refuses a `create table` for a table an
  earlier file created and an `add column` for a column that already exists - the two shapes this
  defect took. It found no other duplicate in the 91 migrations.

## Service - `lib/auth/step-up.ts`

| export | what it decides |
| --- | --- |
| `STEP_UP_WINDOW_MS` | ten minutes |
| `readStepUpState` | pure: the later of `reauthenticated_at` and `mfa_verified_at`, whether it is inside the window, and when it stops counting |
| `requireFreshReauthentication` | the guard: `403 PERMISSION_DENIED` with `{ field: "session", rule: "reauth_required" }` |
| `reauthenticateSession` | the proof and the write |

### Why the later of two instants

A merchant who signed in with the app two minutes ago has already proved exactly what the guard
would ask for. Asking again would train people to treat the prompt as noise, and it would make the
guard cost more than it buys. So the proof that counts is the newer of the sign-in instant (`0010`
already wrote it, and STEP 051 copies it through every rotation) and the step-up instant. What the
window buys is the case it exists for: a session left open on an office machine all afternoon cannot
unlock an account without somebody standing there holding the authenticator.

### Why the code and not the password again

The session already proved the password - that is what signing in is. The second factor is the part
a stolen password cannot supply and, because the secret is sealed in `users` and never sent to a
browser, the part a stolen cookie cannot supply either. Asking for the password a second time would
put a credential through the network again to learn less. A backup code is accepted because section
22 built the codes for that case, and using one spends it.

### The order inside `reauthenticateSession`

1. the session must exist (the cookie was already resolved) - `401` otherwise;
2. `assertAccountUnlocked` - section 22's lock refuses even a correct code, and asking it before the
   code means a locked account cannot be used to test codes (`423`);
3. the account must be active and enrolled - no second factor is `422 two_factor_required`, not a
   wrong code, because the next step is the enrolment;
4. the code is verified - TOTP against the sealed secret, or a backup verifier;
5. a wrong code records a failed `totp` attempt through the same recorder the sign in uses (so two
   wrong codes are a lock there too), audits `session.reauth_rejected`, and answers
   `422 invalid_code`;
6. success writes `reauthenticated_at` on the row **only while it is live**, spends a backup code if
   one was used, and audits `session.reauthenticated`.

## Wiring

- `POST /api/auth/session/reauth` - body read once as text, then the actor, then the STEP 050 proof
  and the STEP 052 device trust (it is in `SENSITIVE_ENDPOINTS`, so the request is signed), then the
  JSON parse, then the service. `200 { status, proof, freshUntilEpochMs, remainingBackupCodes }`,
  `422` with a field and a rule, `403` untrusted device, `423` locked, `401` no session, `413` past
  1 KiB.
- `lib/auth/types.ts` / `request-actor.ts` / `session.ts` - the actor carries `mfaVerifiedAtEpochMs`
  and `reauthenticatedAtEpochMs`, filled from the row by the one reader that reads it. The guard
  therefore does no I/O, and a route cannot invent freshness.
- `lib/auth/session-rotation.ts` - the column is in the row schema, `NewSessionRow` and the REST
  store, `openFamily` writes null, and `rotate` copies the parent's instant into the child: the
  freshness belongs to the login, not to one rotation of it.
- `app/api/office/account-locks/unlock/route.ts` - `requireFreshReauthentication(actor)` after the
  proof and the trust check.
- `lib/auth/disclosure.ts` - the route joins `SESSION_AUTH_SURFACES`.
- `app/(auth)/reauth/page.tsx` - a server component that reads the state and either says "you are
  already confirmed" or shows the form; the form signs the request with the device key.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `node lib/auth/verify.ts` | **1891 checks** (1808 before this STEP); `checkStepUp()` adds 74, the 0091 correction one more |
| `node lib/i18n/verify.ts` | 244 messages, 10 placeholders, 1 locale |
| `npm run check:migrations` | 2714 checks, 91 migrations, 74 tables (after the correction) |
| `npm run check:structure` | 16 directories, 13 root files, 147 source files |
| `npm run check:shell` | 209 checks, 45 files |
| `npm run verify` | exit 0 |
| PGlite proof of `0091` | real `0010` schema, forward/back/forward, 17 checks, 2 controls |

Mutation controls, each applied to the working tree, run, and restored: window widened, window edge
made inclusive, guard never refusing, wrong code not counted, instant not written, rotation dropping
the proof, unlock no longer asking, lock not asked, backup code not spent, actor not carrying the
instant - **10 of 10 fired**.

Live probe on `npm run dev`: `GET /reauth` answers `200` with the signed-out sentence;
`POST /api/auth/session/reauth` answers `401` without a cookie and `413` past 1 KiB; the unlock route
answers `401` without a cookie. The server was stopped afterwards.

## Deliberately not done

- **A password prompt.** See above: it would be the weaker of the two proofs, and the session has
  already made it.
- **A challenge row for the step-up.** A sign-in challenge exists because the provider's token pair
  must wait for a code; a step-up has no token to hold - it writes one instant on a row that already
  exists - so `0082` is not reused and no new table is invented.
- **A separate "reauth attempt" counter.** The step-up counts through `login_attempts` with
  `factor = 'totp'`, which is the same streak the sign-in lock reads.
- **Guards on gateway keys, payouts and KYC decisions.** Those endpoints do not exist yet; each will
  add one call to `requireFreshReauthentication`.
- **`package.json`.** Unchanged (see the request below).

## Package request (unchanged, still open)

`package.json` is the integrator's file, so this is a request and not an edit:

```json
"check:auth": "node lib/auth/verify.ts"
```

and `npm run check:auth` inside `verify`, before `check:lint`. Until it lands the auth gate is run by
hand, which is how every STEP since 050 has run it.

## Next

- **STEP 054 - session and device list with instant revoke.** `SessionTokenStore` already has
  `revokeFamily` and `revokeDevice`, and the actor now carries the family and the device, so a list is
  a read plus one call; `sessions.reauthenticated_at` and `mfa_verified_at` are the two facts a list
  wants to show per row.
- **STEP 055 - IP rate limiting.** `/api/auth/session/reauth` is a code-guessing surface and belongs in
  the same bound as `/api/auth/2fa/verify`.
- **Later** - gateway keys, payouts and KYC decisions each add `requireFreshReauthentication` to their
  route; the guard is already written for them.
