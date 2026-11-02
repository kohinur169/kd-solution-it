// path: docs/planning/STEP_038_SUBSTEP_BREAKDOWN.md
# STEP 038 - Signup flow with email verification, Turnstile and versioned policy acceptance recording

Owner: STEP 038 of `docs/final/STEP_PLAN_250.md` (lines 505-540).
Feature anchors: `docs/final/FEATURE_LIST.md` line 55 (merchant signup), line 245 (Turnstile on
signup, sign in and recovery), line 309 (production site and secret keys), line 338 (go-live needs
Turnstile verified on the production domain).

## 1. What the STEP has to deliver

A stranger can create a merchant account, and the platform can prove afterwards what they accepted.

1. One form: full name, business name, email, password, an unticked box over the twelve policies,
   and a Turnstile challenge.
2. A server route that validates the form, refuses a failed challenge, creates the provider account,
   writes the company, the platform account, the `owner` grant and twelve `policy_acceptances` rows,
   and writes one audit entry - in that order, and compensating if a later write fails.
3. Acceptance is versioned. Each row carries the published page version and the SHA-256 of the body
   the person was shown, so a later edit is a new acceptance rather than a rewritten history.
4. The confirmation mail lands on `/api/auth/verify`, which verifies the token, records
   `users.email_verified_at`, writes `user.email_verified`, and only then sets `__Host-kd_session`.
5. Both screens readable at 1440 px and at 390 px: one column, no horizontal scroll.

## 2. Owned paths

| Path | Change |
| --- | --- |
| `migrations/0080_platform_settings.sql` + `.down.sql` | New: the setting registry the Turnstile secret lives in |
| `lib/auth/rest.ts` | New: PostgREST client (the deployment has no database driver) |
| `lib/auth/secrets.ts` | New: AES-256-GCM sealing of a stored secret |
| `lib/auth/settings.ts` | New: value or secret of one setting |
| `lib/auth/turnstile.ts` | New: the challenge guard |
| `lib/auth/policies.ts` | New: keys, catalog, text hash |
| `lib/auth/password.ts` | New: scrypt verifier, interim shape check |
| `lib/auth/audit.ts` | New: chain entry and signature |
| `lib/auth/registration.ts` | New: the signup service |
| `lib/auth/email-verification.ts` | New: the followed link |
| `lib/auth/client-address.ts` | New: address and agent of a request |
| `lib/auth/runtime.ts` | New: the assembled implementations |
| `lib/auth/http.ts` | Extended: urlencoded form and safe extra headers |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Extended: rules 15-22, 197 new checks |
| `app/api/auth/signup/route.ts`, `app/api/auth/verify/route.ts` | New: the two boundaries |
| `app/(auth)/signup/page.tsx`, `signup-form.tsx`, `app/(auth)/verify/page.tsx` | New: the screens |
| `lib/i18n/strings/en.ts` | Extended: signup, verify and the twelve policy names |

Not touched: the sign in page (STEP 039), the password policy (STEP 040), the dashboard, the
Supabase project, `package.json`.

## 3. Sub-step 038A - the registry and the library

1. `0080`: `public.platform_settings` - a dotted key, either a JSON `value` or the three parts of a
   sealed secret, never both; a guard trigger that refuses delete, a key change and a change of
   `is_secret`; unique live key; RLS default deny with a super admin policy; the seeded
   `turnstile.enabled = false`.
2. `rest.ts`: the only data path, because the deployment ships no database driver. One place maps an
   SQLSTATE and an HTTP status to a catalogue code.
3. `secrets.ts` and `settings.ts`: the master key comes from `ENCRYPTION_MASTER_KEY`, the associated
   data is the setting key, and a damaged row is a platform failure rather than a silent `null`.
4. `turnstile.ts`: enabled by the setting, secret read through `settings.ts`, one `siteverify` call
   through `createAuthHttp`, three verdicts - verified, rejected, upstream.
5. `policies.ts`: the closed twelve-key vocabulary, the published catalog with page version and body
   hash, and the completeness rule the signup depends on.
6. `password.ts`: the scrypt verifier and an interim shape check that STEP 040 replaces wholesale.
7. `audit.ts`: `audit_next_link` then `audit_hash_v1` then the signed insert; no retry, because the
   insert guard is the chain's concurrency control.
8. `registration.ts` and `email-verification.ts`: the two services, both taking their collaborators
   as arguments so the gate can drive every branch.
9. `runtime.ts`: one assembly point, built on first use so a build machine needs no runtime secret.

## 4. Sub-step 038B - the boundaries and the screens

1. `POST /api/auth/signup`: body ceiling, JSON error, address and agent, then the service. `201`
   with `verification_required` or `signed_up`; the catalogue envelope otherwise.
2. `GET /api/auth/verify`: the mail target. A browser that follows a dead link is redirected to a
   page that says so, never handed a JSON envelope; an unexpected failure still reaches the wrapper.
3. `/signup`: a server component with no data of its own - the policy names come from the catalog and
   the Turnstile site key from the public environment - and a client form that resets the challenge
   after a rejected submit.
4. `/verify`: one of three answers, in one of three tones, with no reason why a link failed.
5. Desktop and mobile: the page is one column capped at `max-w-2xl` inside `px-4 py-8`, the fields
   stack, the policy list wraps rather than scrolls sideways, the challenge sits above the fields,
   and the padding grows to `px-6 py-8 sm:p-8` from 640 px up. The verify page caps at `max-w-xl`.
   The layout is fluid rather than two fixed drawings, so the same markup serves both widths.

## 5. Gate and handoff

- `node lib/auth/verify.ts` - 505 checks, of which 197 are STEP 038: secrets, settings, Turnstile
  (five verdict shapes), the three audit calls and the inserted row, the policy catalog, the
  password verifier, the twelve acceptances, the compensation, the confirmation link and the
  address parser.
- `npm run check:migrations` - 2373 checks over 80 migrations.
- Database proof: 80 of 80 forward migrations applied on PostgreSQL 18.6 (PGlite 0.5.14), a plain
  row and a sealed row inserted, the four guard refusals observed, and the down file dropping the
  table cleanly.
- `npm run verify` - the whole gate.
- `docs/handoffs/STEP_038_COMPLETED.md` - what shipped, what the integrator has to do, and the two
  go-live items: the Turnstile secret and the mail template target.
