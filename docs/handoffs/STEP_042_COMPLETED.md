// path: docs/handoffs/STEP_042_COMPLETED.md
# STEP 042 Completed - Handoff

Feature: **2FA verification step in the login flow** (`docs/final/STEP_PLAN_250.md` line 576).
Section 22 (LR-022) makes a second factor mandatory for every account holding a role; STEP 041
delivered enrolment, this STEP delivers the sign in step that consumes it.

## What was delivered

1. **A password no longer signs an enrolled account in.** `signInMerchant` reads
   `users.totp_confirmed_at`; when it is set, the provider's token pair is sealed into a challenge
   row and the browser receives an opaque handle, a `two_factor_required` answer and **no cookie at
   all**. `user.signed_in` is not written at this point, because nothing has signed in.
2. **The code step.** `POST /api/auth/2fa/verify` takes the handle and a code (or a backup code),
   and is the only writer of the session cookie on this path. Success mints a cookie whose signed
   payload carries `assuranceLevel: "aal2"`, records the attempt with `factor = 'totp'` and writes
   `user.signed_in` with `method`, `assurance_level` and `device_proof_present`.
3. **Backup codes are one sign in each.** A code with the shape of `xxxxx-xxxxx` is verified against
   the stored scrypt verifiers, removed from `users.backup_code_hashes`, and audited as
   `user.backup_code_used` with the number left.
4. **The lock has its rows.** Every rejected code is a `login_attempts` row with
   `factor = 'totp'`, `outcome = 'failed'`, the account and the address, so STEP 045's "two
   consecutive failed 2FA attempts" is a query over data this STEP already writes.
5. **The screen.** The sign in form gains one stage: the code field, a rejected-code sentence, an
   expired-challenge sentence driven by a timer (not a render-time clock read) and a way back.

## The defect fixed before the feature (separate commit)

`Fix: sign the session cookie payload and complete the enrolment screen`.

A hand-written cookie authenticated as any account at any assurance level: the session payload was
plain base64url JSON and `readSession` trusted the claims inside it. Reproduced with a probe before
the fix (`forged cookie result: authenticated actor=... aal2=true`) and closed after it
(`unauthenticated`). The payload is now signed with HMAC-SHA-256 under a key derived from
`ENCRYPTION_MASTER_KEY` with HKDF (`kd-session-cookie:v1`), verified before the payload is decoded,
and `createAuthCookiePolicy` requires the master key so a deployment cannot build a policy without
one. The same commit ends the enrolment screen properly: its fourth stage replaces the fall-back to
"create the key", which used to answer `CONFLICT` when pressed a second time.

## Migration

`migrations/0082_auth_challenges.sql` (forward) and `.down.sql` (rollback).

| Column | Meaning |
| --- | --- |
| `user_id`, `company_id` | The account whose password was accepted, and its tenant. |
| `purpose` | `two_factor`, the only purpose this STEP writes. |
| `token_hash` | SHA-256 hex of the browser's handle. The handle is never stored. |
| `secret_ciphertext` | AES-256-GCM box of the provider token pair, challenge in the associated data. |
| `attempt_count` | Rejected codes, ceiling 5 in the service and 10 in the constraint. |
| `expires_at`, `consumed_at` | Ten minute lifetime, single use. |

Plus the seven standard columns, a unique live index on `token_hash`, two partial indexes, the
`set_row_metadata` trigger, RLS and the `auth_challenges_default_deny` policy.

**Rollback proof (PGlite 0.5.14, PostgreSQL engine, 30/30 checks):** `0001` + `0003` + `0082` apply
cleanly; the table, its columns, RLS and the policy exist; a fresh row starts unconsumed with zero
attempts; a second live row for one handle is refused by `auth_challenges_token_key`; an unknown
purpose, a non-hexadecimal hash, an expiry before creation, an eleventh attempt and a challenge for
no account are each refused by their constraint; the trigger bumps `version` to 2 and keeps
`updated_at >= created_at`; the rollback removes the table; the forward file applies again.

## Files

| Path | Change |
| --- | --- |
| `migrations/0082_auth_challenges.sql`, `.down.sql` | new |
| `lib/auth/two-factor-login.ts` | new: issue and complete a challenge |
| `lib/auth/signin.ts` | `outcome` union, the challenge branch, `masterKey` dependency |
| `lib/auth/session.ts` | the signed payload decides assurance, the higher of the two wins |
| `lib/auth/cookies.ts` | `assuranceLevel` in the payload |
| `lib/auth/verify.ts` | 85 new checks (780 -> 865) |
| `lib/auth/README.md` | rules 33-36 |
| `app/api/auth/signin/route.ts` | `two_factor_required`, conditional `set-cookie` |
| `app/api/auth/2fa/verify/route.ts` | new |
| `app/(auth)/signin/signin-form.tsx` | the code stage |
| `lib/i18n/strings/en.ts` | 8 strings in the `signin` group |
| `app/(auth)/README.md` | what the sign in screen does now |
| `docs/planning/STEP_042_SUBSTEP_BREAKDOWN.md` | new |
| `docs/handoffs/STEP_042_COMPLETED.md` | this file |

## Behaviour proof (acceptance checklist)

1. A correct password on an account with a confirmed factor answers `two_factor_required`, writes
   one `auth_challenges` row, audits `user.two_factor_challenged`, and carries **no** `cookies`
   field. Proved in the gate and by the route's conditional `set-cookie` loop.
2. The stored row is keyed by the hash of the handle, and neither the handle nor the refresh token
   appears anywhere in the row in clear.
3. The code from the authenticator is accepted; the challenge is consumed at the stamping instant;
   one attempt row is `succeeded`; one `user.signed_in` entry carries `aal2`; exactly one cookie is
   written, and reading it back through `readSession` answers an authenticated actor with
   `twoFactorSatisfied === true`.
4. Presenting the same handle again, even with the right code, is `AUTHENTICATION_REQUIRED`.
5. A wrong code answers the same sentence, increments `attempt_count`, records a `failed` attempt
   with `factor = 'totp'`, writes no audit entry, and leaves the challenge usable.
6. Five rejected codes reach the ceiling, retire the challenge (`consumed_at` set), and the correct
   code afterwards is refused.
7. An expired challenge, a challenge for a closed account, a challenge whose account lost its second
   factor, and a malformed handle are all the same refusal.
8. A backup code succeeds, leaves nine verifiers, audits `user.backup_code_used` with
   `remaining`, and a code that was already spent is refused.

## Verification

- `node lib/auth/verify.ts`: **865 checks** (780 before this STEP, 772 before STEP 041).
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / 114 source files, env,
  config, i18n **126 messages**, logger 117, errors 196, lint rules 77, shell **139** checks,
  jobs 110, migrations **2424 checks / 82 migrations / 71 tables**, type check, lint, build.
- `npx tsc --noEmit` and `npx eslint .` clean.
- PGlite proof of `0082` and its rollback: 30/30, listed above.
- Live probe on port 3400 (freed afterwards): `GET /signin` 200 with the form; `POST
  /api/auth/2fa/verify` with `{}` answers `401 AUTHENTICATION_REQUIRED`; the same route with a made
  up handle and `POST /api/auth/signin` with an unknown address reach the transport and answer
  `502 DEPENDENCY_FAILED`, because this sandbox has no Supabase project - the wiring is proved, the
  provider exchange is not, and the gate proves the exchange with an injected transport.

## Environment

No new variable. The cookie signing key and the challenge sealing both derive from
`ENCRYPTION_MASTER_KEY`, which is already required; rotating it invalidates every session and every
pending challenge, which is the correct behaviour for a key rotation and is why the STEP 041 handoff
lists it as an operational item.

## Package request (still open, unchanged)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Interpreter note

`app/api/auth/2fa/verify` is the **sign in** step. `/2fa` (STEP 041) remains the **enrolment**
screen. The two are deliberately different routes: one is reachable only with a signed in session,
the other only with a challenge.

## Seams for the next STEPs

- **043 (regenerate backup codes):** the settings action writes the same `backup_code_hashes` array
  this STEP rewrites, and should reuse `generateBackupCodes` + `hashPassword` rather than inventing
  a second format.
- **044 (reset after contact and documents):** `purpose` on `auth_challenges` is a check constraint
  with one value today; a recovery challenge adds a value with an append-only migration rather than
  a second table.
- **045 (lock):** two consecutive `login_attempts` rows with `factor = 'totp'` and
  `outcome = 'failed'` for one account are already written; the lock question goes beside the one
  `signin.ts` leaves marked for it.
- **049/051:** the challenge holds the provider pair; when 051 mints platform sessions, the sealed
  value becomes a session row reference and the rest of this module does not change.
- **Retention:** `auth_challenges_expires_idx` exists for the job that deletes expired challenges;
  the job belongs to the jobs area, not to this STEP.
