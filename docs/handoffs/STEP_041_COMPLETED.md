// path: docs/handoffs/STEP_041_COMPLETED.md
# STEP 041 Completed - Handoff

Feature: **2FA TOTP enrolment with QR code and backup codes** (`docs/final/STEP_PLAN_250.md` line
556). Section 22 of the feature list makes a second factor mandatory for every account holding a
role; this STEP delivers the enrolment half of it and leaves verification at sign in (042), recovery
(044) and the lock (045) their own seams.

## What was delivered

1. **An encoder of our own** - `lib/qr/qr.ts`: byte mode, error correction level M, versions 1 to 10,
   mask 0. A third party image service cannot be used for this, because the payload is an enrolment
   secret, and a package cannot be added without a package request, so the Reed-Solomon arithmetic,
   the interleaving, the function patterns and the two column zigzag live here.
2. **A drawing instead of a picture** - `lib/qr/path.ts`: the matrix as one SVG path of horizontal
   runs plus the extent of the drawing. The screen builds an `<svg>` element from numbers; no markup
   string is injected anywhere and no `<img>` of a generated document is used.
3. **The arithmetic** - `lib/auth/totp.ts`: unpadded base32, RFC 4226/6238 codes (SHA-1, six digits,
   thirty seconds), a verification window of one step on either side that answers *which* step
   matched, the `otpauth://` URI, and ten backup codes of ten characters from an alphabet without
   `0`, `1`, `l` or `o`.
4. **The state machine** - `lib/auth/two-factor.ts`: `startTotpEnrolment` seals a fresh secret with
   AES-256-GCM under `ENCRYPTION_MASTER_KEY` and associated data `users.totp:<id>`; `confirmTotpEnrolment`
   verifies the first code, stamps `totp_confirmed_at` and replaces `backup_code_hashes` with ten
   scrypt verifiers. `hasConfirmedTwoFactor` and `openEnrolledSecret` are the only two questions a
   later STEP needs, so an account with a secret nobody proved is never treated as protected.
5. **Two routes** - `POST /api/auth/2fa/enroll` and `POST /api/auth/2fa/confirm`, both behind the
   STEP 039 session cookie, both `no-store`, neither able to touch an account other than the caller's.
6. **The screen** - `/2fa`, a server component with no data, and a client form with three states:
   idle, started (symbol, grouped key, code field) and enrolled (the ten codes, once, with a warning).

## No migration, and why that is not a gap

`migrations/0003_users.sql` already carries the three columns this feature needs -
`totp_secret_ciphertext` (1..512 characters), `totp_confirmed_at` (nullable, and refused without a
secret) and `backup_code_hashes` (jsonb array of at most 20, replaced whole) - with three guard
constraints, and `login_attempts.factor` already accepts `totp`. This STEP therefore adds no
migration, so there is no rollback to prove and `migrations/` is unchanged at 81 files.

## Files

| Path | Change |
| --- | --- |
| `lib/qr/qr.ts` | new: the encoder |
| `lib/qr/path.ts` | new: the drawing |
| `lib/auth/totp.ts` | new: base32, codes, URI, backup codes |
| `lib/auth/two-factor.ts` | new: enrolment and confirmation |
| `lib/auth/request-actor.ts` | new: cookie to actor, in one place |
| `lib/auth/secrets.ts` | `packSecretBox` / `unpackSecretBox` |
| `lib/auth/runtime.ts` | `directory` and a lazy `masterKey` reader |
| `lib/auth/verify.ts` | 116 new checks (656 -> 772) |
| `lib/auth/README.md` | rules 29-32 |
| `app/api/auth/2fa/enroll/route.ts` | new |
| `app/api/auth/2fa/confirm/route.ts` | new |
| `app/(auth)/2fa/page.tsx`, `app/(auth)/2fa/two-factor-form.tsx` | new |
| `app/(auth)/README.md` | what `/2fa` is |
| `lib/i18n/strings/en.ts` | the `twoFactor` group, 27 strings |
| `styles/tokens.css` | `--kd-symbol`, `--kd-symbol-background` and their Tailwind pairs |
| `docs/planning/STEP_041_SUBSTEP_BREAKDOWN.md` | new |
| `docs/handoffs/STEP_041_COMPLETED.md` | this file |

`styles/tokens.css` is a foundation file, and it is touched deliberately: the shell gate refuses a
colour literal in a component, and a QR symbol must stay dark on light in both themes, so it needs a
semantic pair of its own rather than borrowing `foreground` and `background`, which invert. The two
tokens are `light-dark()` with the same value on both sides for exactly that reason.

## Verification

1. **Encoder against a reference.** With `pip install --target /tmp/pyqr qrcode` (outside the
   repository, never a dependency) 22 payloads were encoded by both implementations, forced to byte
   mode and mask 0: **20 of 20 supported symbols matched module for module** (versions 1 to 10). The
   two payloads that did not fit are 214 and 216 bytes, which need version 11, and this build answers
   `null` for them instead of truncating.
2. **Codewords against a reference.** `encodeQrCodewords` and `python-qrcode`'s `create_data` agree
   byte for byte for a 5 byte and a 14 byte payload, which separates the arithmetic from the drawing:
   when the matrices differed earlier in the STEP, the codewords already matched, so the fault was in
   the function pattern placement, not in the Reed-Solomon work.
3. **Drawing against a decoder.** The emitted path for the real enrolment URI (153 characters) and for
   `hello` were rasterised from the `d` attribute alone and read back with OpenCV's `QRCodeDetector`:
   both payloads decoded **exactly**, which proves the quiet zone, the orientation and the run
   arithmetic as well as the modules.
4. `node lib/auth/verify.ts`: **772 checks** - the RFC 6238 appendix B vectors, the window in both
   directions, the refusal of five and seven digit codes, the URI parameters, base32 round trips, the
   backup code shape and normalisation, the finder patterns, the separators, the timing rows, the
   dark module, both format copies read back as `0x5412`, the drawing's extent and its restricted
   alphabet, and the whole enrolment state machine against a REST double (sealed at rest, opened only
   by its own account and key, a wrong code writing nothing, a confirmed account refused twice).
5. `npm run verify`: exit 0 - structure 16 directories / 13 root files / 112 source files, env,
   config, i18n **116 messages**, logger 117, errors 196, lint rules 77, shell **137** checks with no
   colour literal, jobs, migrations 2393 checks / 81 migrations / 70 tables, type check, lint, build.
   The build lists `/2fa` as a static route and both `2fa` routes as dynamic ones.
6. **Live probe** on port 3300 (freed afterwards): `GET /2fa` answered 200 with the title,
   `POST /api/auth/2fa/enroll` answered `401 AUTHENTICATION_REQUIRED` without a cookie, and
   `POST /api/auth/2fa/confirm` with `{"code":12}` answered `422 VALIDATION_FAILED` with
   `details[0] = {field: "code", rule: "invalid_format"}`.

## Behaviour proof (acceptance checklist)

1. Pressing the button starts an enrolment: a fresh 160 bit secret is generated, sealed, written with
   `totp_confirmed_at = null`, audited, and returned once with its URI and drawing.
2. The screen shows the symbol, the same secret grouped in fours for manual entry, and a note that the
   key is shown once. The symbol is an `<svg>` the page draws from the path, so it is sharp at any size
   and in both themes.
3. Typing the current code confirms: the account gets `totp_confirmed_at`, ten backup codes replace
   the column, and the screen shows them once with a warning that the platform keeps only verifiers.
4. A wrong or malformed code answers 422 naming the code field, writes nothing and audits nothing.
5. An account that is already enrolled is refused with `CONFLICT` on both routes: replacing an
   authenticator is a recovery flow (STEP 044), not a second enrolment.
6. A confirmation without a start is `CONFLICT`; a sealed value this build did not write is
   `INTERNAL_ERROR`; an account that disappeared is `AUTHENTICATION_REQUIRED`.
7. Nobody else's account can be enrolled: the actor is read from the cookie and the body carries no
   identity at all.

## Package request (still open)

`package.json` is integrator owned, so this STEP adds no dependency - the encoder exists so that no
dependency is needed. The STEP 040 request stands:

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Go-live items still open (unchanged, plus one)

- Seal `turnstile.secret_key`, flip `turnstile.enabled` and set `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
- Point the Supabase confirmation template at `/api/auth/verify?token_hash={{ .TokenHash }}&type={{ .Type }}`.
- Run `bootstrap_super_admin()`.
- The first outbound HTTPS deployment performs the first live breach-corpus call.
- **New:** `ENCRYPTION_MASTER_KEY` must be the same value on every instance from now on. A rotated key
  makes every stored TOTP secret unreadable, which strands enrolled accounts; rotation is STEP 044's
  recovery flow or a maintenance window with re-enrolment, never a silent change.

## Seams for the next STEPs

- **042 (2FA verification at sign in):** `verifyTotpCode` returns the step it matched, so a replay of
  the same step can be refused by recording the step; `openEnrolledSecret` reads the sealed secret for
  the account; `RequestActor.twoFactorSatisfied` still comes from the `aal2` claim, which 042 raises.
- **044 (reset / recovery):** a confirmed account answers `CONFLICT` on `enroll`; that is the point
  where a recovery flow has to prove identity before replacing a secret.
- **045 (lock):** `login_attempts.factor` already accepts `totp`, and the recorder of STEP 039 takes
  the factor as an argument, so a failed code can be recorded without a schema change.
- **049/050/051/052/055:** untouched; `request-actor.ts` is the cookie-to-actor step those routes will
  use rather than decoding a token themselves.
