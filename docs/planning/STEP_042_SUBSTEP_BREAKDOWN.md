// path: docs/planning/STEP_042_SUBSTEP_BREAKDOWN.md
# STEP 042 sub-step breakdown

Feature: the 2FA verification step in the login flow.
Plan line: `docs/final/STEP_PLAN_250.md` line 576.
Owner of the paths below: STEP 042 only.

## 1. Read the ground first, then check it

- `docs/final/FEATURE_LIST.md` section 22 (LR-022) and `docs/final/MASTER_PROMPT.md` rules 1-17.
- `docs/handoffs/STEP_041_COMPLETED.md`, then `git log`, `git status`, `git ls-remote` and every
  gate, so the STEP starts from a tree that is clean, pushed and green.

## 2. The defect found while reading, and fixed before any feature work

A hand-written cookie authenticated as any account at any assurance level. `readSession` decoded the
claims out of the provider token in the payload without any integrity check, and the payload itself
was plain base64url JSON, so a browser could mint `{"sub": "<any user>", "exp": <future>, "aal":
"aal2"}` and be believed. That is fatal for this STEP in particular: a second factor that a cookie
can skip is not a second factor.

The fix signs the payload (HMAC-SHA-256, key derived from `ENCRYPTION_MASTER_KEY` with HKDF and the
info string `kd-session-cookie:v1`) and refuses a value that does not carry the signature this
policy would have written. It is a separate commit, `Fix: sign the session cookie payload and
complete the enrolment screen`, together with a second defect - the enrolment screen fell back to
its start button after "I have saved the codes", so the flow had no end.

## 3. Owned paths

| Path | Why |
| --- | --- |
| `migrations/0082_auth_challenges.sql` + `.down.sql` | The pending challenge a correct password creates. |
| `lib/auth/two-factor-login.ts` | Issue a challenge, complete it with a code or a backup code. |
| `lib/auth/signin.ts` | A correct password stops when the account has a confirmed factor. |
| `lib/auth/session.ts` | The signed payload decides the assurance, raised by the payload not the token. |
| `lib/auth/cookies.ts` | `assuranceLevel` in the signed payload. |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Rules 33-36 and their proof. |
| `app/api/auth/signin/route.ts` | Answers `two_factor_required` and writes no cookie. |
| `app/api/auth/2fa/verify/route.ts` | The code step: the only place this path writes a cookie. |
| `app/(auth)/signin/signin-form.tsx`, `lib/i18n/strings/en.ts` | The code step on the sign in screen. |
| `app/(auth)/README.md` | What the sign in screen now does. |

## 4. The database part

`0082` creates `public.auth_challenges`: the account, the purpose, the SHA-256 of the handle the
browser holds, the sealed provider token pair, an attempt counter, the expiry and the consumed
instant, with the seven standard columns, three indexes, the metadata trigger, RLS and the
default-deny policy. Rollback drops the table. Proof: a PGlite run applying `0001`, `0003`, `0082`,
exercising the constraints, the trigger and the rollback.

## 5. The service

1. `issueTwoFactorChallenge` writes one row: a 32 byte handle, its SHA-256, and the pair sealed with
   the challenge in the associated data. Ten minute lifetime.
2. `completeTwoFactorChallenge` reads the challenge, the account, then the code, in that order, and
   answers one generic refusal for every failure. Five rejected codes retire the challenge; a
   success consumes it, records the attempt, audits `user.signed_in` with `aal2` and mints the
   cookie. A backup code is accepted by its shape, verified against the stored scrypt verifiers,
   removed from the array and audited as `user.backup_code_used`.
3. `assuranceLevel: "aal2"` travels inside the **signed** payload, so `readSession` reports
   `twoFactorSatisfied` for the session the code produced and for nothing else.

## 6. The routes and the screen

- `POST /api/auth/signin` gains one answer shape: `two_factor_required` with the handle and the
  expiry, and no `set-cookie` at all.
- `POST /api/auth/2fa/verify` takes the handle and a code, and is the only writer of the cookie on
  this path.
- The sign in form gains one stage: the code field, a message for a rejected code, a message for an
  expired challenge (a timer, not a render time comparison, because a component that reads the clock
  while rendering is not pure) and a way back to the password form.

## 7. The security review

| Question | Answer |
| --- | --- |
| Validation | The handle and the code are bounded and shape checked before any query; the route refuses a body over 2 KiB. |
| RLS | `0082` enables it and grants nothing; the service uses the service role like every other writer. |
| Audit | `user.two_factor_challenged` at the password step, `user.backup_code_used` when a code is spent, `user.signed_in` with `aal2` only after the code. |
| Permission | A challenge names one account and can only produce that account's session; the handle is random and stored hashed. |
| Replay | The challenge is consumed on success, so one password entry yields one session; a second presentation is the generic refusal. |
| Brute force | Five guesses per challenge, then it retires; every rejection is a `login_attempts` row with `factor = 'totp'` for the lock in STEP 045. |
| Secret at rest | The provider pair is AES-256-GCM under the master key with the challenge in the associated data. |
| Enumeration | A wrong code, an expired challenge, a consumed one and an unknown handle all answer `AUTHENTICATION_REQUIRED`. |

## 8. Gates and commit

`npx tsc --noEmit`, `npx eslint .`, `npm run verify`, `node lib/auth/verify.ts`, the migration gate
and a PGlite proof, then one commit and the handoff file. One commit for the feature; the defect fix
was committed before it so the history says which is which.

## Seams left for later STEPs

- 043: regenerate backup codes - `completeTwoFactorChallenge` already rewrites the array, so the
  settings action reuses the same shape.
- 044: reset workflow - a confirmed account answers `CONFLICT` at enrolment, and this STEP's
  challenge table is the natural place to record a recovery challenge purpose.
- 045: the lock reads `login_attempts` where `factor = 'totp'` now has rows.
- 051: the session row and rotation replace the provider pair in the challenge with a platform
  minted session; the challenge itself needs no change.
