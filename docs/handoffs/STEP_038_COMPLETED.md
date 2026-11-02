// path: docs/handoffs/STEP_038_COMPLETED.md
# STEP 038 Completed - Handoff

## STEP
- Number and title: STEP 038 - Signup flow with email verification, Turnstile and versioned policy
  acceptance recording.
- Category: Authentication and Session Security (STEP 037-055).
- Depends on (earlier STEPs and their handoff files): STEP 004 (the environment contract, the
  server only keys and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`), STEP 006 (the English catalog, which now
  carries the signup and verification copy), STEP 008 (the error code catalog and the envelope the
  routes answer with, unchanged), STEP 013 (`public.users`, `public.role_assignments`), STEP 015
  (the session table STEP 051 fills), STEP 033 (the role vocabulary, `owner` included), STEP 035
  (the policy layer), STEP 036 (`0075`-`0079`, the audit chain functions, the guard triggers and
  `public.bootstrap_super_admin()`), STEP 037 (the transport, the cookie policy and the client this
  STEP calls).
  The split of this STEP is `docs/planning/STEP_038_SUBSTEP_BREAKDOWN.md`: **038A** the registry
  and the library, **038B** the two boundaries and the two screens.

## Files
- Created:
  - `migrations/0080_platform_settings.sql` + `.down.sql` - `public.platform_settings`: a dotted
    key, either a JSON `value` or the three parts of a sealed secret, never both; a guard trigger
    that refuses delete, a key change and a change of `is_secret`; one unique live key; RLS default
    deny plus a super admin policy; the seeded `turnstile.enabled = false`.
  - `lib/auth/rest.ts` - the serviceless PostgREST client (`select`, `insert`, `insertReturning`,
    `update`, `rpc`) and the single place an SQLSTATE or an HTTP status becomes a catalogue code.
  - `lib/auth/secrets.ts` - AES-256-GCM sealing: 12 byte vector, 16 byte tag, the setting key as
    associated data, the master key from `ENCRYPTION_MASTER_KEY`, a failure that is
    `INTERNAL_ERROR` and never a partial value.
  - `lib/auth/settings.ts` - one setting, read through a narrow projection; a damaged row is
    `DEPENDENCY_FAILED`, a missing key is `null`.
  - `lib/auth/turnstile.ts` - the guard: `siteverify` through `createAuthHttp`, three verdicts,
    closed by default, and a production deployment that refuses instead of skipping.
  - `lib/auth/policies.ts` - the twelve key vocabulary of `0052`, the published catalog with the
    page version and the SHA-256 of the body, and the completeness rule.
  - `lib/auth/password.ts` - the scrypt verifier (`scrypt$N$r$p$salt$hash`) and an interim shape
    check that STEP 040 replaces.
  - `lib/auth/audit.ts` - `audit_next_link`, `audit_hash_v1`, the Ed25519 signature over the hash
    and the insert; no retry, because the insert guard is the chain's concurrency control.
  - `lib/auth/registration.ts` - the signup service and its compensation.
  - `lib/auth/email-verification.ts` - the followed confirmation link: token, verification instant,
    audit entry, then the cookie.
  - `lib/auth/client-address.ts` - the request address and agent, refusing anything that is not an
    address so an `inet` column never receives a claim.
  - `lib/auth/runtime.ts` - one assembly point for the real implementations, built on first use.
  - `app/api/auth/signup/route.ts`, `app/api/auth/verify/route.ts` - the two boundaries.
  - `app/(auth)/signup/page.tsx`, `app/(auth)/signup/signup-form.tsx`, `app/(auth)/verify/page.tsx`
    - the screens.
  - `docs/planning/STEP_038_SUBSTEP_BREAKDOWN.md`, this file.
- Modified:
  - `lib/auth/http.ts` - `AuthRequest` gained an urlencoded `form` and safe extra `headers`; the
    reserved header names (apikey, authorization, accept, content-type, content-length,
    x-client-info) can never be overridden, so a caller cannot smuggle a key.
  - `lib/auth/verify.ts` - 197 new checks over the ten new modules.
  - `lib/auth/README.md` - the file table and rules 15-22.
  - `lib/i18n/strings/en.ts` - the `signup`, `verify` and `policies` groups.
- Not touched: the sign in page (STEP 039), the password policy (STEP 040), the dashboard, the
  Supabase project, `package.json`, `package-lock.json`.

## Database
- Migration: `0080_platform_settings.sql` (forward) and `0080_platform_settings.down.sql`.
- Rollback verified on a clean database: **yes**. The full forward chain was applied on PostgreSQL
  18.6 (PGlite 0.5.14, wasm build, no native server in the sandbox): 80 of 80 files applied, then
  `0080` was exercised and reverted:
  - `to_regclass('public.platform_settings')` answered the table after the chain and `null` after
    the down file;
  - a plain row (`turnstile.enabled` seeded `false`) and a sealed row both inserted;
  - `Bad.Key`, a plain row carrying a secret part, `delete`, a key change and an `is_secret` change
    were each refused by the named constraint or the trigger message;
  - an update of `value` was accepted and the metadata trigger moved `version` from 1 to 2;
  - `relrowsecurity` is `true`, the policies are `platform_settings_default_deny` and
    `platform_settings_super_admin_all`, the triggers are `platform_settings_guard_state` and
    `platform_settings_set_row_metadata`, the indexes include `platform_settings_key_key` and
    `platform_settings_secret_idx`.
- Everything the STEP writes elsewhere already exists and is unchanged: `0052` policy acceptances
  (guard trigger, unique live index), `0013` audit log, `0075` chain functions, `0001`/`0003`/`0004`
  for the company, the account and the grant.
- One defect was found by that proof and fixed before the commit: the ciphertext check used
  `{1,8192}`, and PostgreSQL's regex engine refuses a repetition count above 255, which made a
  secret row impossible to insert. It is now `char_length(...) between 1 and 8192` plus a charset
  test.

## Environment
- No new variable. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is now rendered by `/signup`,
  `ENCRYPTION_MASTER_KEY` seals and opens the Turnstile secret, and `AUDIT_SIGNING_KEY` signs every
  audit entry. `APP_URL` goes live with STEP 039, when there is a link to build.
- The Turnstile **secret** is not an environment variable: it lives in `platform_settings` sealed
  with `ENCRYPTION_MASTER_KEY`, which is what makes rotation a row update rather than a deploy.

## Packages
- No package was added or removed. Nothing is requested for this STEP.
- Still outstanding from STEP 037 and repeated here because it now covers two STEPs of code: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` in `package.json`, and insert
  `npm run check:auth` into `verify` immediately before `npm run check:lint`, so a regression in
  `lib/auth` fails the standard command. `package.json` is not mine to edit.

## Behaviour Proof (acceptance checklist)
1. A stranger opens `/signup`, sees four fields, one unticked box over the twelve policy names, the
   challenge area and the submit button. Rendered and read at both widths; the page is one column
   capped at `max-w-2xl` inside `px-4 py-8`, growing to `px-6 py-8 sm:p-8` from 640 px.
2. A rejected form keeps what was typed, prints one catalogue sentence, resets the challenge and
   lets the person submit again.
3. The policy box starts unticked. Submitting with it unticked fails on the server as well: the
   body carries `acceptedPolicies: []`, and the service answers `VALIDATION_FAILED`.
4. The twelve acceptances are written with the published page's `version` and the SHA-256 of the
   body, one row each, `accepted_by` the new account, `company_id` the new company. A catalog that
   is not complete is `SERVICE_UNAVAILABLE`, never eleven rows.
5. The writes are ordered provider account, company, account, owner grant, acceptances, audit. A
   failure after the provider account exists soft deletes the rows it created, deletes that account
   through the service role and rethrows the original error.
6. A duplicate address is not disclosed: the provider's rejection becomes the same
   `VALIDATION_FAILED` sentence as a form problem, and the route answers `201` with the same body
   whether or not a mail was sent.
7. Turnstile is closed by default. The seeded row is `false`; in development a closed switch skips
   the challenge, outside development it refuses the request, and an enabled switch without a
   secret is a `DEPENDENCY_FAILED` rather than an open door.
8. The confirmation mail target verifies the token, records `users.email_verified_at`, writes
   `user.email_verified` and only then sets `__Host-kd_session`; a dead link redirects to
   `/verify?status=invalid`, an unreachable provider to `?status=unavailable`, and neither page says
   why a particular link failed.
9. Both API routes are `force-dynamic`, answer `cache-control: no-store` and carry the wrapper's
   `x-request-id`; a body over 8 KiB is `PAYLOAD_TOO_LARGE` before it is parsed.
10. No token, cookie, secret, key or password reaches a log line, an envelope, a detail or a
    response header. Details name a field and a rule only.

## Verification
- Typecheck result: `npm run typecheck` passes with no output.
- Lint result: `npm run lint` and `npm run check:lint` pass; the matrix still requires all
  twenty-six rules as errors.
- Build result: `npm run build` succeeds and lists `/signup` as static, `/verify` and both
  `/api/auth/*` routes as dynamic.
- Gate: `node lib/auth/verify.ts` prints `auth gate passed: 505 checks, cookie
  "__Host-kd_session", 8 chunk ceiling` (302 after STEP 037, 197 added here).
- `npm run check:migrations` prints `2373 checks, 80 migrations, 70 tables`.
- `npm run verify` exits 0 with every gate, the typecheck, the lint and the build in sequence.
- Structure gate: green, 96 source files, every new file starts with its `// path:` comment.
- Live check against `npm run dev`: `/signup` and the three `/verify` states answered `200` with the
  expected headings, `POST /api/auth/signup` answered `422` with field details for an empty body and
  `502 DEPENDENCY_FAILED` for a valid body on a sandbox with no project to reach, which is the
  intended answer when the platform's database is unreachable.

## Next
- Next STEP number: STEP 039 - sign in, which reuses `client.signInWithPassword`, the same Turnstile
  guard, `createAuthCookiePolicy` and the one generic rejection.
- Anything the next chat must know:
  1. `getAuthRuntime()` is the only way a route in this area builds its collaborators. A sign in
     route adds its method to that object; it does not build a client, a cookie policy or an audit
     trail of its own.
  2. `POST /api/auth/signup` is deliberately without a rate limit; STEP 055 wraps the handler. Keep
     the handler's shape so the limiter can be inserted without touching the service.
  3. Two go-live items are open and neither is code:
     - **Turnstile**: create the widget for the production domain, put the secret into
       `platform_settings` through `sealSecret(ENCRYPTION_MASTER_KEY, secret,
       secretContextFor("turnstile.secret_key"))`, flip `turnstile.enabled` to `true`, and set
       `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. `FEATURE_LIST.md` line 338 makes this a go-live gate.
     - **Mail template**: point the Supabase confirmation template at
       `/api/auth/verify?token_hash={{ .TokenHash }}&type={{ .Type }}` on `APP_URL`; with the default
       template the link never reaches this route and no account is ever verified.
     - **Policy pages**: the twelve pages of `0078` are seeded as drafts and
       `public.bootstrap_super_admin()` of `0079` publishes them in the transaction that creates the
       first account. Signup on a database where the bootstrap has not run answers
       `SERVICE_UNAVAILABLE`, which is the designed answer and not a defect: consent is recorded
       against published text, so the bootstrap is a prerequisite of the first real signup.
  4. The audit chain is per company, with `PLATFORM_CHAIN_ID` (all zero UUID) for platform events.
     Never write an audit row with a hand made sequence: the insert guard refuses it and the caller
     has no way to recover the link.
  5. STEP 040 replaces `assertPasswordAcceptable` wholesale and keeps `hashPassword` and
     `verifyPasswordHash`. Every existing hash keeps verifying because the parameters are in the
     string.
  6. STEP 051 adds the server side session row between the token check and the directory lookup in
     `readSession`; `email-verification.ts` writes the cookie through `encodeSessionCookies` and is
     the second caller that will need the row.
