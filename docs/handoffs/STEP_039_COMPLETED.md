// path: docs/handoffs/STEP_039_COMPLETED.md
# STEP 039 Completed - Handoff

## STEP
- Number and title: STEP 039 - Login flow with Turnstile and device registration.
- Category: Authentication and Session Security (STEP 037-055).
- Depends on (earlier STEPs and their handoff files): STEP 004 (the environment contract and the
  public Turnstile site key), STEP 006 (the catalog, which now carries the sign-in copy), STEP 008
  (the envelope and the code table), STEP 015 (`public.device_proof_keys`, `public.sessions`,
  `public.login_attempts`, `public.account_locks`), STEP 033 (the role vocabulary), STEP 036
  (`0013`/`0075`, the audit chain this STEP appends to), STEP 037 (the transport, the cookie policy,
  the client and `credentialRejectionError`), STEP 038 (the Turnstile guard, the settings registry,
  the audit trail, `runtime.ts` and the signup screen this one is the sibling of).
  The split of this STEP is `docs/planning/STEP_039_SUBSTEP_BREAKDOWN.md`: **039A** the record and
  the service, **039B** the boundary and the screen.

## Files
- Created:
  - `lib/auth/device-context.ts` - the device label of a user agent, and the SHA-256 of an address
    nobody owns. Families are matched most specific first, because Edge, Opera and Chrome on iOS all
    claim to be something else.
  - `lib/auth/login-attempts.ts` - the writer of `public.login_attempts`, with the identity rule in
    one function: the account when it is known, the address hash when it is not.
  - `lib/auth/signin.ts` - the service: validate, challenge, exchange, platform account check,
    device context, attempt row, audit entry, cookie.
  - `app/api/auth/signin/route.ts` - the boundary.
  - `app/(auth)/signin/page.tsx`, `app/(auth)/signin/signin-form.tsx` - the screen.
  - `docs/planning/STEP_039_SUBSTEP_BREAKDOWN.md`, this file.
- Modified:
  - `lib/auth/runtime.ts` - the attempt recorder joins the assembled object, and the settings reader
    is built once instead of twice.
  - `lib/auth/verify.ts` - 97 new checks.
  - `lib/auth/README.md` - the file table and rules 23-25.
  - `lib/i18n/strings/en.ts` - the `signin` group.
- Not touched: the dashboard, the lock (STEP 045), the rate limiter (STEP 055), the device proof key
  (STEP 049), the rotating session (STEP 051), `package.json`, `package-lock.json`.

## Database
- Migration: **none, deliberately**. `0009` gives the device proof key, `0010` the session row,
  `0011` the attempt record and `0012` the lock, and `0011` already carries the four indexes the
  counters need (`login_attempts_user_idx`, `_ip_idx`, `_email_idx`, `_created_idx`). A second
  device table in this STEP would collide with `0009`, and a schema change with no new fact to store
  is the kind of migration the append-only rule exists to prevent.
- Proof against the real schema instead, because this STEP writes tables it does not own: the full
  forward chain (80 files) was applied on PostgreSQL 18.6 (PGlite 0.5.14), a company and an account
  were created, and `createRestLoginAttemptRecorder` - the real module, not a copy - wrote two rows:
  - a succeeded attempt for the known account: `user_id` set, `email_hash` null, `203.0.113.9/32`;
  - a failed attempt for an unknown address: `user_id` null, `email_hash` 64 hex characters,
    `2001:db8::1/128`;
  - an attempt with no address returned `false` and wrote nothing, which is the documented answer
    for a request that reached the origin without a forwarding header;
  - the database itself refused a row carrying both identity columns
    (`login_attempts_identity_known_check`), which is the rule the writer follows.

## Environment
- No new variable. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is now rendered by `/signin` as well, and the
  Turnstile secret and switch stay in `platform_settings` (`0080`), not in the environment.

## Packages
- No package was added or removed. Nothing is requested for this STEP.
- Still outstanding from STEP 037 and now covering three STEPs of code: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` in `package.json`, and insert
  `npm run check:auth` into `verify` immediately before `npm run check:lint`.

## Behaviour Proof (acceptance checklist)
1. `/signin` asks for the work email and the password, renders the same Turnstile widget as signup,
   and links to `/signup` for a visitor with no account. One column, `max-w-md`, the padding scale of
   the signup screen; readable at 1440 px and 390 px because the layout is fluid rather than fixed.
2. A wrong password, an unknown address, an unconfirmed address, a closed account and an account
   without a platform row all answer `401 AUTHENTICATION_REQUIRED` with the same body: the gate
   compares the code, the status and the detail count of five different causes.
3. A malformed form is the same answer, so the shape of a request cannot be used to learn whether an
   address exists; an unknown field is refused rather than ignored.
4. Turnstile runs before the exchange. A missing or refused token is `VALIDATION_FAILED` with the
   detail `{field: "turnstileToken", rule: "challenge_failed"}` and is recorded as `challenged`; a
   production deployment with the switch off is a `DEPENDENCY_FAILED`, never an open door.
5. Every attempt is a row in `public.login_attempts` before it is a decision: factor, outcome,
   address, agent, and exactly one of `user_id` and `email_hash`. A record that fails changes
   nothing the merchant sees, and the audit entry says whether the row landed.
6. The session cookie is written only after the exchange, the account check and the audit entry. The
   gate asserts the `__Host-kd_session` name and `HttpOnly`.
7. The device is recorded and the answer is honest about it: `deviceProofRequired` is true exactly
   when the account has no live `device_proof_keys` row, and the audit payload carries the derived
   label (`Chrome on macOS`) and the assurance level.
8. `POST /api/auth/signin` is `force-dynamic`, answers `cache-control: no-store` and the wrapper's
   `x-request-id`, refuses a body over 4 KiB before parsing it, and sets the cookie on the response
   that carried the answer.
9. Nothing secret reaches a log line, an envelope or a detail: the attempt row is the only place the
   reason is written, and only the platform can read that table.

## Verification
- Typecheck result: `npm run typecheck` passes with no output.
- Lint result: `npm run lint` and `npm run check:lint` pass; twenty-six rules as errors.
- Build result: `npm run build` succeeds; `/signin` is static, `/api/auth/signin` is dynamic.
- Gate: `node lib/auth/verify.ts` prints `auth gate passed: 602 checks, cookie "__Host-kd_session",
  8 chunk ceiling` (505 after STEP 038, 97 added here), stable across three consecutive runs.
- `npm run check:migrations` prints `2373 checks, 80 migrations, 70 tables`.
- `npm run verify` exits 0 with every gate, the typecheck, the lint and the build in sequence.
- Live check against `npm run dev`: `/signin` answered `200` with both the heading and the signup
  link; `POST /api/auth/signin` with `{}` answered `401` with the generic envelope and the expected
  headers, and with a well formed body answered `502 DEPENDENCY_FAILED` on a sandbox with no project
  to reach, which is the intended answer when the settings read cannot be served.

## Next
- Next STEP number: STEP 040 - password policy enforcement and breached password check.
- Anything the next chat must know:
  1. STEP 040 replaces `assertPasswordAcceptable` in `lib/auth/password.ts` wholesale and keeps
     `hashPassword`/`verifyPasswordHash`, which already store their parameters
     (`scrypt$16384$8$1$salt$hash`) so every existing verifier keeps verifying. Signup calls the
     check in `registration.ts`; nothing else calls it yet.
  2. STEP 045's lock belongs between the challenge and the exchange in `signInMerchant`; the comment
     in that function names the spot, and `public.account_locks` plus `login_attempts` are what it
     counts. The attempt writer already records `blocked` as an outcome, so the lock needs no new
     vocabulary.
  3. The attempt writer refuses to record a request with no address, because
     `login_attempts.ip_address` is `inet NOT NULL`. STEP 055 makes an address a requirement of the
     authentication routes; until then the returned boolean is the signal that a row was skipped.
  4. Device proof keys are STEP 049's browser work and the `sessions` row is STEP 051's. This STEP
     deliberately writes neither: `0009` needs a client public key and `0010` needs that key before a
     session can exist, so the sign in reports `deviceProofRequired` instead of inventing a device.
  5. The sign in lands the browser on `/`, because there is no dashboard yet; STEP 056 replaces the
     `afterSigninPath` constant in `app/(auth)/signin/page.tsx`, and nothing else.
