// path: docs/planning/STEP_043_SUBSTEP_BREAKDOWN.md
# STEP 043 sub-step breakdown

Feature: backup code regeneration for merchants inside settings.
Plan line: `docs/final/STEP_PLAN_250.md` line 596.
Owner of the paths below: STEP 043 only (auth STEPs 037-055 own `app/(auth)/`, `app/api/auth/`,
`lib/auth/`, plus their own migration numbers).

## 1. Read the ground first, then check it

- `docs/final/FEATURE_LIST.md` section 22: "2FA TOTP is mandatory for every account holding role,
  with backup codes" and "Merchants can generate fresh backup codes in advance".
- `docs/final/MASTER_PROMPT.md` rules 1-17, `docs/handoffs/STEP_042_COMPLETED.md`.
- `git log`, `git status`, `git ls-remote`, every gate.

## 2. The defect found while reading, and fixed before any feature work

The sealed session of a two-factor challenge could not hold the token pair the module itself
accepts. `0082` bounded `auth_challenges.secret_ciphertext` at 4 096 characters and `isSecretBox`
bounded a ciphertext part at 8 192, while a pair at `MAXIMUM_ACCESS_TOKEN_LENGTH` (4 096) and a
2 048 character refresh token seals to **8 395** characters. Measured, not guessed:

```
typical supabase pair    packed chars:   1483  fits
large pair               packed chars:   5003  EXCEEDS 4096 COLUMN BOUND
documented maxima        packed chars:   8395  EXCEEDS 4096 COLUMN BOUND
```

Two fixes, in one commit, `Fix: size the sealed challenge for the token pair it accepts`:
`0083` widens the column to 16 384 (append-only, with a rollback that refuses while a larger row is
pending), and `isSecretBox` moves its ceiling to the same number, because a box this module sealed
must be a box this module can open.

## 3. Owned paths

| Path | Why |
| --- | --- |
| `migrations/0083_auth_challenge_secret_size.sql` + `.down.sql` | The defect fix above. |
| `lib/auth/secrets.ts` | The ciphertext ceiling that matches the widest column. |
| `lib/auth/backup-codes.ts` | `readTwoFactorStatus` and `regenerateBackupCodes`. |
| `app/api/auth/2fa/backup-codes/route.ts` | The POST that replaces the set. |
| `app/(auth)/2fa/settings/page.tsx` + `backup-codes-form.tsx` | The settings screen. |
| `lib/i18n/strings/en.ts` | The `twoFactor` strings for that screen. |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Rules 37-39 and their proof. |
| `app/(auth)/README.md` | What `/2fa/settings` is. |

No migration for the feature itself: `users.backup_code_hashes` already holds ten verifiers and is
replaced whole, which is exactly what a regeneration is.

## 4. The service

1. `readTwoFactorStatus` answers `{enrolled, confirmedAt, backupCodesRemaining}` for the signed in
   account, and refuses an account that is missing, closed or deleted.
2. `regenerateBackupCodes({userId, code})` requires the current TOTP code - a set of ten codes is ten
   ways in, and a session alone must not be able to mint them - then replaces the column with ten
   fresh scrypt verifiers and audits `user.backup_codes_regenerated` with `issued` and `replaced`.
3. A wrong code is `VALIDATION_FAILED` with `field: "code"`; an account with no confirmed factor is
   `CONFLICT`; a closed or deleted account is `AUTHENTICATION_REQUIRED`.

## 5. The route and the screen

- `POST /api/auth/2fa/backup-codes` takes `{code}`, requires the session, answers the ten codes once
  with `no-store`, and answers `PAYLOAD_TOO_LARGE` above 1 KiB.
- `/2fa/settings` is a dynamic server component: it reads the session and the account on the server,
  so the panel never opens in a loading state, and it renders three states - signed out, unavailable,
  ready. The client form only posts.
- Mobile: single column, numeric keypad on the code field, full width buttons. Desktop: the same
  panel capped at `max-w-xl`, two column code grid.

## 6. The security review

| Question | Answer |
| --- | --- |
| Validation | The code is `[0-9]{6}` before any query; the body is bounded at 1 KiB. |
| RLS | No new table; `users` is read and written through the same service role as every other writer. |
| Audit | One entry per regeneration, with `issued` and `replaced`, never a code. |
| Permission | The route requires the session *and* the current second factor; the account comes from the cookie, never from the body. |
| Old codes | The column is replaced whole; the gate verifies that an old code no longer matches any new verifier. |
| Exposure | The codes exist in clear in one response and one screen, are never logged, and cannot be recovered afterwards. |

## 7. Gates and commit

`npx tsc --noEmit`, `npx eslint .`, `npm run verify`, `node lib/auth/verify.ts`, the migration gate and
a PGlite proof of `0083` and its rollback, then one commit and the handoff file. The defect fix was
committed before the feature so the history says which is which.

## Seams left for later STEPs

- 044: the reset workflow after email contact and document verification - a merchant with no working
  code and no working app follows that path, not this screen.
- 045: the lock counts `login_attempts` rows; this screen writes none, because a wrong code here is
  not a sign in attempt.
- 056+: the security STEPs may add a reauthentication window; this action's own proof is the code.
