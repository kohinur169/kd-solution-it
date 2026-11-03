// path: docs/handoffs/STEP_082_COMPLETED.md
# STEP 082 - Business address and contact information section: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 082 code are in one commit, the
one whose message is "STEP 082: Business address and contact information section" (`git log -1` on
the branch shows its hash). Previous handoff: `docs/handoffs/STEP_081_COMPLETED.md`.

## STEP

- **Number and title:** STEP 082 - Business address and contact information section
  (`docs/final/STEP_PLAN_250.md`, the STEP 082 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  Fourth STEP of the block, and the second that points the profile at a `0076`/`0077` reference row.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`. This STEP uses the first two and leaves `services/submerchant/` to the
  provisioning STEPs that follow.
- **Feature list:** section 5 - "Fields include business name, business address, person name,
  contact information..." and "Merchant sets business information once on the platform. The same
  information is sent to every connected processor." 0102's `address` step is described as "the
  registered address and the contact details of the person who owns the account".
- **Depends on:** STEP 079 (`0102_onboarding_progress.sql`, `services/kyc/onboarding-steps.ts`,
  `app/(dashboard)/onboarding/owner-actor.ts`), STEP 080 (`0103_business_profiles.sql`,
  `services/kyc/business-profile.ts`, `ONBOARDING_STEP_FORMS` in `step-copy.ts`), STEP 081
  (`0104_merchant_category_code.sql`, `services/kyc/merchant-category.ts`), STEP 036
  (`0076_reference_countries.sql` - the 250-country list, BD enabled, CU/IR/KP/SY sanctioned and
  disabled, frozen by its guard), STEP 056 (`lib/auth/rest.ts`), STEP 057
  (`lib/security/csrf.ts`, `lib/security/csrf-client.ts`), STEP 038 (the signup email pattern),
  STEP 074 (the settings phone pattern), STEP 001 (`0001_companies.sql`).

## Files

- **Created:** `migrations/0105_business_address.sql`,
  `migrations/0105_business_address.down.sql`, `services/kyc/business-address.ts`,
  `services/kyc/business-address-fields.ts`, `app/api/onboarding/business-address/route.ts`,
  `app/(dashboard)/onboarding/address/page.tsx`,
  `app/(dashboard)/onboarding/address/address-form.tsx`,
  `docs/planning/STEP_082_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_082_COMPLETED.md`.
- **Modified:** `services/kyc/verify.ts` (the gate grew the address sections and the fake store
  learned the `countries` table and the ten new profile columns; 944 -> 1277 checks),
  `lib/i18n/strings/en.ts` (the `onboardingAddress` block, 50 strings, 3 placeholders),
  `lib/security/csrf.ts` (`"/api/onboarding/business-address"` on `CSRF_PROTECTED_PATHS`),
  `app/(dashboard)/onboarding/step-copy.ts` (`address: "/onboarding/address"` in
  `ONBOARDING_STEP_FORMS`), `lib/auth/verify.ts` (baselines 10 keepers / 24 mutation files / 27 call
  sites; 2467 -> 2471 checks), `README.md` (migration table now ends at `0105`),
  `app/(dashboard)/README.md` (the `onboarding/address/` bullet).
- **Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md):**
  `app/(dashboard)/onboarding/` and `services/kyc/`. `services/submerchant/` untouched.

## Database

- **Migrations added:** `migrations/0105_business_address.sql` and
  `migrations/0105_business_address.down.sql`.
- **What 0105 adds:** `countries_code_unique unique (code)` on the 0076 table (a foreign key needs a
  full unique constraint; 0076's index is partial, and its guard refuses every delete, so the full
  constraint is the same rule); nine address/contact columns on `public.business_profiles`;
  `business_profiles_country_fkey` to `public.countries (code)`; per-column check constraints
  (trimmed, length-bounded lines; postal 3-12 of letters/digits/space/hyphen; country upper-case
  alpha-2; email lower case 5-254; phone `+`-optional digits/spaces/parens/hyphens); the derived
  `address_completed_at` with a check that requires all seven required fields and an instant >=
  `created_at`; the office index `business_profiles_country_idx`.
- **Rollback verified on clean database:** yes - `/tmp/proof/proof105.mjs` (PGlite, real 0001 + 0076
  + 0077 + 0103 + 0104 + 0105) applies `0105_business_address.down.sql` and confirms the ten columns,
  the constraints and the index are gone, `countries_code_unique` is gone, the 250 country rows and
  the 0103 profile row (with 0104's `mcc_code`) survive. 54 checks passed.

## Environment

- **Environment variables added to .env.example:** none.
- **Secrets handled:** none (names only, never values): the service role key and the session
  cookie stay as they were; no new secret exists for this STEP.

## Packages

- **Package requests for the integrator:** none. (`@electric-sql/pglite` was used only for the
  rollback proof, from `/tmp/proof`, outside the repository; it is not a dependency.)

## Behaviour Proof (acceptance checklist)

- **Behaviours named in the STEP title, exercised and observed:**
  - The nine fields save as a draft: a partial save (line1 + city) stores and leaves
    `address_completed_at` null (gate `checkAddressSave` and `checkAddressRead`; PGlite proof).
  - The seven required fields stamp the completion: the full save writes all nine columns plus
    `address_completed_at = now()`, the `address` wizard step is mirrored finished into 0102
    (created opening on `category`), and clearing one required field un-stamps it and drops the
    step again (gate; PGlite: stamp without facts refused, stamp before `created_at` refused).
  - The country must be an enabled row of 0076: FK refuses `ZZ`, the format check refuses lowercase
    `bd`, the service refuses `unknown_country` / `disabled_country` (AQ in the gate's fake list)
    with zero writes (PGlite + gate).
  - Email and phone match the platform's existing patterns: upper-case email refused by the column
    check, `not-an-email` refused, five-character phone refused (PGlite); the service lower cases
    the email before storing (gate).
  - A save is a patch: the update carries exactly the named fields plus `address_completed_at` -
    asserted key-exact in the gate, so STEP 080's and STEP 081's fields are never rewritten.
  - Unknown keys are named (`unknown_key`), wrong types are `invalid_format`, an empty body is
    `required`; all refusals happen before any query (gate).
  - Every save appends exactly one `business_address.saved` audit entry with
    `{fields, complete, completed_now, missing, saved_at}`; an audit-sink failure does not fail the
    save (gate).
- **UI checks:** `/onboarding/address` renders four separate states (signed out, forbidden,
  unreadable, ready) - the dev smoke observed the signed-out sentence; the form renders one input
  per field with a filter box narrowing a native `select` of enabled countries (keyboard
  navigable), per-field errors, the missing-fields line and the saved/complete lines; copy is in
  the `onboardingAddress` catalog for light/dark themes; desktop width exercised in the smoke,
  mobile is the same single-column layout as `/onboarding/business` (a person should still confirm
  at 360 px on staging).
- **API checks:** dev smoke on port 3107: `GET /onboarding/address` 200 with the signed-out
  sentence; `POST /api/onboarding/business-address` with no token 422 `csrf_token_invalid`, with a
  wrong token 422, `GET` on the POST-only route 405. Gate: all eight refused actors get
  `PERMISSION_DENIED` with zero queries, writes and audit entries; a cross-tenant read answers the
  other company's own empty state, never the row's.
- **Money flow ledger proof:** not applicable (no money moves in this STEP).
- **Provider sandbox cycle:** not applicable (STEP 083 reads this row when it opens a
  sub-merchant).

## Security proof

- The company is the session's: `requireAnyRole(actor, ONBOARDING_OWNER_ROLES)` + `requireCompanyId`
  run before the first query; the gate asserts no query, no write and no audit for each of the
  eight refused actors (six office roles, an owner with no company, nobody).
- CSRF: the path is on `CSRF_PROTECTED_PATHS`; the gate asserts the route checks the token before
  the session and the body, bounds the body at 8 KiB, and takes no company from the caller; the
  form sends one fetch with one CSRF spread (the auth gate counts both: 10 keepers, 24 mutation
  files, 27 call sites).
- RLS: `business_profiles` and `countries` stay default-deny from 0103/0076; the service reads
  with the service role key, and the dropdown payload carries only enabled codes and names - never
  the sanction notes.
- The refusal a client sees is `{field, rule}` in the platform's own envelope; no typed value is
  echoed back.
- The database itself refuses what the service might one day get wrong: the FK, the format checks
  and the completion checks are all in 0105 and all proven in PGlite.

## Verification

- Typecheck: `npm run -s typecheck` -> exit 0.
- Lint: `npm run -s lint` -> exit 0 (0 problems).
- Build: full `npm run -s verify` -> **exit 0** (every gate, tsc, eslint, `next build`), with
  `/onboarding/address` and `/api/onboarding/business-address` in the build's route list.
- Gates: `node services/kyc/verify.ts` -> **1277 checks** (6 steps, 1 role, 7 business fields,
  5 processors, `business_profiles` table, `mcc_codes` vocabulary, `countries` list);
  `npm run -s check:migrations` -> 3057 checks, **105 migrations**, 78 tables;
  `npm run -s check:i18n` -> **1219 messages, 113 placeholders**; `npm run -s check:structure` ->
  270 source files; `npm run -s check:shell` -> 431 checks, 111 files; `npm run -s check:errors` ->
  202 checks; `npm run -s check:config` -> 10 sections, 28 values; `npm run -s check:lint` -> 77
  checks; `node lib/auth/verify.ts` -> **2471 checks** (10 session keepers, 24 browser mutation
  files, 27 call sites); `node lib/security/verify.ts` -> 2376 checks.
- PGlite migration proof: `/tmp/proof/proof105.mjs` -> **54 checks passed**, including the negative
  control and the rollback.
- Dev smoke on port 3107 (`.env.local` copied from `.env.example` and removed afterwards):
  `GET /onboarding/address` 200 with "Sign in with a merchant account to fill in the address and
  contact."; `POST /api/onboarding/business-address` no token 422 `csrf_token_invalid`, wrong
  token 422; `GET` on the route 405.

## Known limitation, recorded rather than hidden

- "Profile settings" has no screen of its own yet, same as STEP 081: the merchant dashboard is
  onboarding-only so far. The address lives once on the `business_profiles` row, which is what
  makes "set once, sent to every processor" true; when the settings STEP lands it edits these
  columns through `saveBusinessAddress`.
- "The country must be enabled" is the service's rule, not a constraint, because `is_enabled`
  changes at runtime without a migration; the foreign key keeps the reference itself honest. The
  split is stated in the 0105 header so it reads as a decision.
- The dropdown ships all enabled countries in one payload (246 rows in the seed, a few KiB) and the
  filter is client-side: one query, no loop, fine at the ISO list's size.
- The gate cannot prove PostgREST is reachable, that 0105 was applied to a particular project, or
  that a person can use the form at two widths - the deployment checks below cover those.
- The client form imports the field list from `services/kyc/business-address-fields.ts`, not from
  the service, because a value import from the service pulled the database client (`node:net`) into
  the browser bundle and broke the build; the fields module exists for exactly that reason.

## Deployment checks a person runs

1. Apply `0105_business_address.sql` (migration gate count goes to 105) and run
   `0105_business_address.down.sql` on a scratch project; confirm the ten columns are gone,
   `countries` still holds 250 rows and the profile rows are intact.
2. Sign in as an `owner` with a company, open `/onboarding`, press "Open the form" on the address
   card, fill the seven required fields choosing `BD` in the country filter: the row shows all nine
   columns, `address_completed_at` is set, one `business_address.saved` audit entry names the
   fields, and the wizard's address step is finished (position moves to `category`).
3. Save `country_code = ZZ`: 422 `unknown_country`; choose a sanctioned country by editing the
   request: 422 `disabled_country`; save an upper-case email: 422 `invalid_format`; clear the
   contact phone: the stamp is removed and the address step is no longer finished.
4. Save only `address_line2`: the update touches exactly `address_line2` and
   `address_completed_at` - the `mcc_code` and the STEP 080 fields keep their values.
5. Sign in as an office role and open `/onboarding/address`: the refusal sentence, no form; POST the
   route: 403 (and without a CSRF token: 422 first).

## Next

- **Next STEP number:** 083 - "One-time business profile that feeds every processor".
- **Anything the next chat must know:** STEP 083 reads the one `business_profiles` row - legal
  name, trading name and friends from STEP 080, `mcc_code` from STEP 081, and the nine address and
  contact columns plus `address_completed_at` from this STEP - when it opens a sub-merchant at every
  connected processor, so it must treat the address as read-only input and never re-derive
  `address_completed_at` (0103's `completed_at` rule is untouched). The patch-save discipline
  (one route per section, named fields only, insert-with-update-fallback, one audit entry,
  audit-sink failure tolerated) is now the pattern in `services/kyc/business-profile.ts`,
  `merchant-category.ts` and `business-address.ts` - copy it. `services/kyc/business-address-fields.ts`
  shows how to share a field list with a client form without leaking server imports into the browser
  bundle. The wizard map already has `address: "/onboarding/address"`, so the address card on
  `/onboarding` links to the new form.
