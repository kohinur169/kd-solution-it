// path: docs/handoffs/STEP_043_COMPLETED.md
# STEP 043 Completed - Handoff

Feature: **backup code regeneration for merchants inside settings** (`docs/final/STEP_PLAN_250.md`
line 596), from section 22's "Merchants can generate fresh backup codes in advance".

## What was delivered

1. **A settings screen that tells the truth about the account.** `/2fa/settings` is a dynamic server
   component: it reads the session and the account row on the server and renders the state of the
   second factor - on or off, when it was confirmed, and how many backup codes remain - with a
   sentence that says what an empty set means. It never renders a loading shell and never shows
   someone else's state.
2. **A replacement, not an addition.** `POST /api/auth/2fa/backup-codes` writes ten fresh scrypt
   verifiers over `users.backup_code_hashes` and answers the codes once. An old code stops working at
   that instant, which the gate proves by verifying an old code against the new column.
3. **The second factor is the proof.** The action requires the current TOTP code as well as the
   session: a set of ten codes is ten new ways into the account, and a stolen session must not be
   able to mint them. A wrong code is `422` naming the code field; an account with no confirmed
   factor is `CONFLICT` and the screen points at enrolment instead.
4. **Ten codes, still once.** The response is the only place the new codes exist in clear. The
   platform stores verifiers, the screen says the previous set no longer works beside the new codes,
   and no route can read a code back.

## The defect fixed before the feature (separate commit)

`Fix: size the sealed challenge for the token pair it accepts`.

STEP 042 sealed the provider token pair into `auth_challenges.secret_ciphertext`, bounded at 4 096
characters, while the pair it accepts - a 4 096 character access token and a 2 048 character refresh
token - seals to **8 395**. An enrolled account whose provider returned a large pair could not sign
in at all. Measured with the real helpers:

```
typical supabase pair    packed chars:   1483  fits
large pair               packed chars:   5003  EXCEEDS 4096 COLUMN BOUND
documented maxima        packed chars:   8395  EXCEEDS 4096 COLUMN BOUND
```

Two changes, because the defect had two halves:

- `0083_auth_challenge_secret_size.sql` widens the check to 16 384, with a rollback that restores
  4 096 and refuses while a larger challenge is pending rather than truncating a sealed session.
- `isSecretBox` in `lib/auth/secrets.ts` moves its ciphertext ceiling from 8 192 to the same 16 384.
  Without this, the widened column would still have been rejected by the reader as "not a box this
  build wrote" - a refusal no operator could diagnose and no retry could fix.

The gate now seals a pair at the documented maxima, asserts it exceeds the old bound and fits the new
one, and completes a sign in with it - which also proves the multi chunk cookie path, since the
resulting payload spans three cookies.

## Migration

`migrations/0083_auth_challenge_secret_size.sql` (forward) and `.down.sql` (rollback). No migration
for the feature itself: `users.backup_code_hashes` already holds the ten verifiers and is replaced
whole.

**Rollback proof (PGlite 0.5.14, PostgreSQL engine, 13/13 checks):** `0082` refuses a 5 048 character
box; `0083` applies cleanly; 5 048 and 8 443 character boxes are accepted; 17 048 is still refused;
the floor is unchanged; the rollback is refused while a large challenge is pending; the rollback
applies once nothing large is pending; the 4 096 ceiling is back and a small box still fits; the
forward file applies again.

## Files

| Path | Change |
| --- | --- |
| `migrations/0083_auth_challenge_secret_size.sql`, `.down.sql` | new (defect fix) |
| `lib/auth/secrets.ts` | ciphertext ceiling matches the widest column |
| `lib/auth/backup-codes.ts` | new: status and regeneration |
| `app/api/auth/2fa/backup-codes/route.ts` | new |
| `app/(auth)/2fa/settings/page.tsx`, `backup-codes-form.tsx` | new |
| `lib/auth/verify.ts` | 41 new checks (871 -> 912) |
| `lib/auth/README.md` | rules 37-39 |
| `lib/i18n/strings/en.ts` | 13 strings in the `twoFactor` group |
| `app/(auth)/README.md` | what `/2fa/settings` is |
| `docs/planning/STEP_043_SUBSTEP_BREAKDOWN.md` | new |
| `docs/handoffs/STEP_043_COMPLETED.md` | this file |

## Behaviour proof (acceptance checklist)

1. A confirmed account reads as enrolled with the count of its verifiers, never a code, and the
   confirmation instant.
2. A regeneration with the current code issues ten distinct codes, writes one row on that account,
   replaces the column whole, and audits `user.backup_codes_regenerated` with `issued: 10` and
   `replaced` equal to the previous count.
3. An old code no longer verifies against the first *or* the last new verifier, while a code from the
   new set verifies - checked with the same scrypt verifier the sign in uses.
4. A fresh code works where it matters: the gate completes a sign in through
   `completeTwoFactorChallenge` with a regenerated backup code and observes the set shrink to nine.
5. A wrong code is `VALIDATION_FAILED` with `field: "code"`, writes nothing and audits nothing; a
   malformed code fails on its shape before any query.
6. An account without a confirmed factor is `CONFLICT` (and the status says "not enrolled" with zero
   codes, so the screen offers enrolment); a closed or deleted account is `AUTHENTICATION_REQUIRED`.

## Verification

- `node lib/auth/verify.ts`: **912 checks** (871 before this STEP; 865 before the defect fix).
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **118 source files**, env,
  config, i18n **140 messages / 5 placeholders**, logger 117, errors 196, lint rules 77, shell **150**
  checks, jobs 110, migrations **2444 checks / 83 migrations / 71 tables**, type check, lint, build.
- Build output lists `/2fa/settings` and `/api/auth/2fa/backup-codes` as dynamic routes.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Live probe on port 3500 (freed afterwards): `GET /2fa/settings` answers 200 with the title for a
  visitor with no cookie and renders the signed out sentence; `POST /api/auth/2fa/backup-codes`
  without a cookie answers `401 AUTHENTICATION_REQUIRED`; the same POST with a hand-written cookie
  answers `401` as well, which is the signed payload check of the STEP 042 fix doing its work.

## Design notes worth keeping

- The status read is on the server. A client `useEffect` fetch would have been flagged by the
  repository's `react-hooks/set-state-in-effect` rule, and the house has no `eslint-disable` anywhere;
  more importantly the panel is the screen a worried person opens, so it must not open in "loading".
- The screen has three states - signed out, unavailable, ready - because folding them into one null
  would tell a signed out person that their account is broken.
- A wrong code on this screen is **not** a `login_attempts` row: it is not a sign in, and counting it
  would let anyone with a session push an account toward the lock of STEP 045.

## Package request (still open, unchanged)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Seams for the next STEPs

- **044 (reset after contact and documents):** this screen cannot help someone who has lost the
  authenticator *and* every code; that path proves identity by email plus documents and clears
  `totp_confirmed_at`, after which `/2fa` enrols again. `auth_challenges.purpose` is a check
  constraint with one value, so a recovery challenge adds a value with an append-only migration.
- **045 (lock):** this action writes no attempts, by design; the lock keeps counting real sign in
  attempts only.
- **056+ (security):** a reauthentication window would let this action reuse a recent proof; today
  the code itself is the proof and it is cheap enough to ask for.
- **Retention:** regenerated hashes replace the old ones, so nothing accumulates; the audit entry is
  the only history, and it holds counts rather than codes.
