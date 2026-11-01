// path: docs/planning/STEP_041_SUBSTEP_BREAKDOWN.md
# STEP 041 sub-step breakdown

Feature: two factor authentication, TOTP enrolment with a QR code and backup codes.
Plan line: `docs/final/STEP_PLAN_250.md` line 556.
Owner of the paths below: STEP 041 only. Nothing outside this list is written.

## 1. Read the ground before writing

- `docs/final/FEATURE_LIST.md` section 22 and `docs/final/MASTER_PROMPT.md` rules 1-17.
- `docs/handoffs/STEP_040_COMPLETED.md`, then `git log`, `git status` and the gates, so the work
  starts from a tree that is clean and pushed.
- `migrations/0003_users.sql`: the storage already exists - `totp_secret_ciphertext` (1..512),
  `totp_confirmed_at` (nullable, refused without a secret), `backup_code_hashes` (jsonb array of at
  most 20) - and `login_attempts.factor` already accepts `totp`. Conclusion: **no migration**, and
  therefore no rollback to prove.

## 2. Owned paths

| Path | Why |
| --- | --- |
| `lib/qr/qr.ts` | The encoder: byte mode, level M, versions 1-10, mask 0. |
| `lib/qr/path.ts` | The matrix as one SVG path of runs, plus the extent of the drawing. |
| `lib/auth/totp.ts` | RFC 6238 codes, base32, the `otpauth://` URI and the backup codes. |
| `lib/auth/two-factor.ts` | The enrolment state machine over `users`. |
| `lib/auth/secrets.ts` | `packSecretBox` / `unpackSecretBox`, for a box in one column. |
| `lib/auth/request-actor.ts` | The cookie-to-actor step every authenticated route repeats. |
| `lib/auth/runtime.ts` | The actor directory and the master key reader. |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Rules 29-32 and their proof. |
| `app/api/auth/2fa/enroll/route.ts` | Start an enrolment. |
| `app/api/auth/2fa/confirm/route.ts` | Confirm a code, answer the backup codes once. |
| `app/(auth)/2fa/page.tsx`, `app/(auth)/2fa/two-factor-form.tsx` | The screen, desktop and mobile. |
| `app/(auth)/README.md` | What `/2fa` is, and which routes answer it. |
| `lib/i18n/strings/en.ts` | Every sentence on that screen, in the `twoFactor` group. |
| `styles/tokens.css` | Two semantic tokens, because the shell gate refuses a colour literal. |

## 3. The encoder, before anything else

1. Write the QR table for versions 1-10 at level M and the smallest version a byte payload fits.
2. Encode: mode byte, the length in 8 or 16 bits, the bytes, the terminator, the padding bytes.
3. Reed-Solomon over GF(256) with the generator polynomial of each block count, then interleave.
4. Draw: finders, separators, timing, alignment (2..10), the dark module, both format copies, the
   version blocks from 7 up, then the data in the two column zigzag, skipping column 6, mask 0.
5. Prove it against a reference encoder - `python3 -m pip install qrcode` outside the repository -
   module for module, over 22 payloads from 1 byte to the largest this build accepts.
6. Prove the drawing with a decoder, not an encoder: rasterise the emitted path and read it back
   with OpenCV's `QRCodeDetector`.

## 4. The arithmetic

- `base32Encode` / `base32Decode`, unpadded, the alphabet authenticator apps read.
- `totpCodeForStep` as RFC 4226: HMAC-SHA-1 over the big-endian step, dynamic truncation, six digits.
- `verifyTotpCode` over `[-1, +1]` steps, constant time, answering the step or null.
- RFC 6238 appendix B vectors, including the 2005 instants, in the gate.
- Backup codes: ten of `xxxxx-xxxxx`, an alphabet without look-alikes, normalised before hashing.

## 5. The service

1. `startTotpEnrolment` reads the account, refuses a confirmed one with `CONFLICT`, seals a fresh
   secret with the associated data `users.totp:<id>`, writes it with `totp_confirmed_at = null` and
   audits `user.totp_enrolment_started`.
2. `confirmTotpEnrolment` validates the code's shape, opens the sealed secret, verifies the code,
   hashes ten fresh backup codes, writes `totp_confirmed_at` and `backup_code_hashes` in one update
   and audits `user.totp_enrolled` with the count and the step.
3. `hasConfirmedTwoFactor` and `openEnrolledSecret` are the seams STEP 042 (verification at sign in)
   and STEP 044 (recovery) consume; nothing in this STEP reads the secret back for a screen.

## 6. The routes

- `POST /api/auth/2fa/enroll`: body of at most 1 KiB (none is needed), session required, answers the
  secret, the grouped secret, the URI and the drawing, with `Cache-Control: no-store`.
- `POST /api/auth/2fa/confirm`: body `{code}`, session required, 422 with `field: "code"` for a wrong
  or malformed code, `CONFLICT` for an account that is already enrolled or never started.
- Neither route can be answered for another person's account: the actor comes from the cookie, never
  from the body.

## 7. The screen

- `/2fa` is a server component with no data; the secret exists only after the button is pressed.
- Three states: idle, started (symbol, grouped key, code field), enrolled (the ten codes, shown once,
  with a warning before the button that leaves).
- The symbol is an `<svg>` built from the drawing's numbers: no `<img>` of a generated document, no
  `dangerouslySetInnerHTML`.
- Desktop: symbol beside the key at `sm:`. Mobile: stacked, full width fields, a numeric keypad for
  the code field, 44 px targets.

## 8. The security review

| Question | Answer |
| --- | --- |
| Validation | Every body is bounded and shape-checked; the code is `[0-9]{6}` before a query. |
| RLS | No new table and no new policy: the service reads and writes `users` through the same REST client and the same role as STEP 039. |
| Audit | Two entries, one per state change, on the tenant chain when the account has a company. |
| Permission | Both routes require the STEP 039 session; the actor's own row is the only row they touch. |
| Secret at rest | AES-256-GCM under `ENCRYPTION_MASTER_KEY`, associated data naming the account. |
| Secret in transit | `no-store`, and only in the answer to the start request. |
| Replay | The matched step is returned, so STEP 042 can refuse a step that was already used. |

## 9. Gates

- `npx tsc --noEmit`, `npx eslint .`, `npm run verify` (structure, env, config, i18n, logger, errors,
  lint rules, shell, jobs, migrations, types, lint, build).
- `node lib/auth/verify.ts`: 656 checks before this STEP, 772 after it - 116 new ones.
- A live probe on a spare port: `/2fa` answers 200 with the title, `enroll` answers 401 without a
  cookie, `confirm` answers 422 `invalid_format` for a body that is not a code.

## 10. Commit

One commit, `STEP 041: 2FA TOTP enrollment with QR code and backup codes`, pushed to the session
branch, followed by `docs/handoffs/STEP_041_COMPLETED.md`.

## Seams left for later STEPs

- 042: verify a code at sign in and refuse a replayed step (`verifyTotpCode` returns the step).
- 044: replace a lost authenticator - the `CONFLICT` on a confirmed account is where it starts.
- 045: the lock reads `login_attempts`, which already accepts `factor = 'totp'`.
- 049/050/051/052/055: untouched, and `RequestActor.twoFactorSatisfied` still comes from the claim.
