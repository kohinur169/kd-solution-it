// path: docs/planning/STEP_039_SUBSTEP_BREAKDOWN.md
# STEP 039 - Login flow with Turnstile and device registration

Owner: STEP 039 of `docs/final/STEP_PLAN_250.md` (lines 532-543).
Feature anchors: `docs/final/FEATURE_LIST.md` line 245 (Turnstile on signup, sign in and recovery),
line 243 (a lock that survives restarts is a database fact), line 244 (LR-022), line 250 (the
generic error rule).

## 1. What the STEP has to deliver

1. A sign in screen: work email, password, Turnstile, and nothing that says whether an address exists.
2. A route that verifies the challenge, exchanges the password for a session, refuses an account the
   platform does not have, and writes the session cookie only after the audit entry.
3. The attempt is a row, not a counter in memory: `public.login_attempts` (0011) gets one row per
   sign in with the factor, the outcome, the address, the agent and - for an address the platform
   does not know - the hash of the address rather than the address.
4. Device registration, at the level this STEP can honestly own: the sign in records the device
   context of the request (browser and platform labels, address, agent) and reports whether the
   account already has a device proof key. STEP 049 generates the key pair in the browser and
   registers the public half in `device_proof_keys` (0009); STEP 051 writes the `sessions` row that
   binds the proof key to the cookie. Neither table can be written before those STEPs: `0010`
   requires a `device_proof_key_id` and `0009` requires a client public key, so inventing one here
   would be a fabricated device. The sign in therefore answers `device_proof_required` and the
   next STEP enrols.

## 2. Owned paths

| Path | Change |
| --- | --- |
| `lib/auth/device-context.ts` | New: the device label and the address hash of one request |
| `lib/auth/login-attempts.ts` | New: the attempt writer over `public.login_attempts` |
| `lib/auth/signin.ts` | New: the sign in service |
| `lib/auth/runtime.ts` | Extended: the attempt recorder joins the assembled object |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Extended: rules and checks |
| `app/api/auth/signin/route.ts` | New: the boundary |
| `app/(auth)/signin/page.tsx`, `signin-form.tsx` | New: the screen |
| `lib/i18n/strings/en.ts` | Extended: the `signin` group |
| `docs/planning/STEP_039_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_039_COMPLETED.md` | New |

No migration. `0009`, `0010`, `0011` and `0012` already ship the device, session, attempt and lock
tables, and `0011` already carries the four indexes the counters need. A STEP that adds a second
device table would collide with `0009`.

Not touched: the dashboard (STEP 056+), the lock service (STEP 045), the rate limiter (STEP 055),
the device proof key (STEP 049), the rotating session (STEP 051), `package.json`.

## 3. Sub-step 039A - the record and the service

1. `device-context.ts`: one place reads a user agent into a bounded label, and one place hashes an
   address so an unknown account never stores an address.
2. `login-attempts.ts`: the writer of `login_attempts`. One identity column per row, enforced by the
   database: the account when it is known, the address hash when it is not.
3. `signin.ts`: validate, challenge, exchange, platform account check, device context, attempt row,
   audit entry, cookie. One failure for a wrong password, an unknown address, an unconfirmed address
   and a closed account.

## 4. Sub-step 039B - the boundary and the screen

1. `POST /api/auth/signin`: body ceiling, JSON refusal, address, agent, then the service. `200` with
   `signed_in` and the device flag, one `AUTHENTICATION_REQUIRED` for every credential failure.
2. `/signin`: a server component that renders the same Turnstile widget as signup and a client form
   that shows one sentence for every rejection and resets the challenge.
3. Desktop and mobile: one column capped at `max-w-md`, the same padding scale as `/signup`.

## 5. Gate and handoff

- `node lib/auth/verify.ts`: new checks for the device context, the attempt writer, the service and
  the credential uniformity (six rejection shapes produce one error).
- `npm run verify`: the whole gate.
- Database proof: the attempt row and the account projection are checked against the real schema on
  PostgreSQL 18.6 (PGlite 0.5.14), because both are new writes on tables this STEP does not own.
- `docs/handoffs/STEP_039_COMPLETED.md`.
