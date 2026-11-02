// path: docs/handoffs/STEP_081_COMPLETED.md
# STEP 081 - Merchant Category Code field in onboarding and profile settings: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 081 code are in one commit, the
one whose message is "STEP 081: Merchant Category Code field in onboarding and profile settings"
(`git log -1` on the branch shows its hash). Previous handoff:
`docs/handoffs/STEP_080_COMPLETED.md`.

## STEP

- **Number and title:** STEP 081 - Merchant Category Code field in onboarding and profile settings
  (`docs/final/STEP_PLAN_250.md`, the STEP 081 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  Third STEP of the block, and the first that reads the `0077` vocabulary.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`. This STEP uses the first two and leaves `services/submerchant/` to the
  provisioning STEPs that follow.
- **Feature list:** section 5 - "Merchant Category Code (MCC) dropdown or input in merchant onboarding
  and profile settings", and "MCC based risk tiers with extra reserve or longer hold" (the risk tier
  itself stays with the compliance team, per `0077`).
- **Depends on:** STEP 079 (`0102_onboarding_progress.sql`, `services/kyc/onboarding-steps.ts`,
  `app/(dashboard)/onboarding/owner-actor.ts`), STEP 080 (`0103_business_profiles.sql`,
  `services/kyc/business-profile.ts`, the `ONBOARDING_STEP_FORMS` map in `step-copy.ts`), STEP 036
  (`0077_reference_mcc_codes.sql` - the 981 published codes, frozen by its guard), STEP 056
  (`lib/auth/rest.ts`), STEP 057 (`lib/security/csrf.ts`, `lib/security/csrf-client.ts`), STEP 001
  (`0001_companies.sql` - the tenant root and `set_row_metadata`).

## Files

- **Created:** `migrations/0104_merchant_category_code.sql`,
  `migrations/0104_merchant_category_code.down.sql`, `services/kyc/merchant-category.ts`,
  `app/api/onboarding/merchant-category/route.ts`,
  `app/(dashboard)/onboarding/category/page.tsx`,
  `app/(dashboard)/onboarding/category/category-form.tsx`,
  `docs/planning/STEP_081_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_081_COMPLETED.md`.
- **Modified:** `services/kyc/verify.ts` (the gate grew the category sections and the fake store
  learned `mcc_codes` and the `mcc_code` column; 663 -> 944 checks), `lib/i18n/strings/en.ts` (the
  `onboardingCategory` block, 31 strings, 3 placeholders), `lib/security/csrf.ts` (one path on the
  protected list: `/api/onboarding/merchant-category`), `lib/auth/verify.ts` (session keeper count
  8 -> 9, browser mutation files 22 -> 23, call sites 25 -> 26; 2463 -> 2467 checks),
  `app/(dashboard)/onboarding/step-copy.ts` (`category: "/onboarding/category"` in
  `ONBOARDING_STEP_FORMS`), `app/(dashboard)/README.md` (the category form line),
  `README.md` (the `0104` row in the migration table, heading now "0080 to 0104").
- **Not touched:** `package.json`, `package-lock.json`, every other migration, every other STEP's
  files. The two foreign files (`lib/security/csrf.ts`, `lib/auth/verify.ts`) were touched only as
  registrations, exactly as STEP 079 and STEP 080 did: a POST route must be on
  `CSRF_PROTECTED_PATHS`, and the baseline counts in the auth gate must count the new page and form.

## Database

- **Migrations added:** `0104_merchant_category_code.sql` and its `.down.sql`.
- **What 0104 does:** adds `business_profiles.mcc_code text` (one column on the profile row of 0103,
  so onboarding and profile settings share the one stored field and every section 6 adapter reads
  the same four digits); `business_profiles_mcc_code_check` (`^[0-9]{4}$`, leading zeros kept, so
  `0742` stays distinct from `742`); `business_profiles_mcc_fkey` to `public.mcc_codes (code)`, which
  required adding `mcc_codes_code_unique unique (code)` to the 0077 table - a foreign key cannot
  reference 0077's partial unique index, and the full constraint is safe because 0077's guard
  refuses every delete; `business_profiles_mcc_idx` for the STEP 090 underwriting screen; a column
  comment. The column is deliberately not part of 0103's completion check: the category is the
  wizard's own `category` step, and the service decides when it is finished.
- **Rollback verified on a clean database:** yes. `/tmp/proof/proof104.mjs` (PGlite 0.5.14, installed
  `--no-save` outside the repository, not part of the build) applied the real `0001`, stubbed the two
  actor functions 0072 normally provides, then the real `0077`, `0103` and `0104`, and finally the
  real `0104` rollback: **24 checks passed** - the column, the unique constraint and the index
  exist; `5411` and the leading-zero `0742` store; `9999` is refused by the foreign key; `123`,
  `54a1` and `54111` are refused by the format check; a duplicate code is refused; 0077's guard still
  refuses a delete; retiring `0742` leaves the stored reference valid; a negative control dropped the
  check and the foreign key and wrote `12`, proving they were the things refusing it; the rollback
  removed the column, both constraints and the index and left the 981 vocabulary rows and the 0103
  profile row intact.
- **Migration gate:** `npm run -s check:migrations` -> **3027 checks, 104 migrations, 78 tables**
  (no new table, so the table count is unchanged).

## Environment

- **Environment variables added to .env.example:** none. The route reads nothing from the
  environment beyond the same `getAuthRuntime()` the STEP 079/080 routes use.
- **Secrets handled:** none.

## Packages

- **Package requests for the integrator:** none. `package.json` and `package-lock.json` are
  untouched. PGlite was used for the migration proof only, installed with `--no-save` in `/tmp`,
  outside the repository.

## What was built

- **`services/kyc/merchant-category.ts` - the read and the save of the one column.**
  `readMerchantCategory` answers the caller's own company with the stored code, its published title
  and the dropdown: the active rows of `mcc_codes` in code order (a stored code that was retired
  afterwards still resolves its title through one extra bounded read, so an old choice names itself
  while leaving the dropdown). `parseMerchantCategoryInput` accepts exactly `{ mcc_code }`: unknown
  keys, wrong types and anything that is not four digits after sanitising are refused with
  `{field, rule}`; an empty string or null is a deliberate clear. `saveMerchantCategory` checks the
  code against the vocabulary **before** writing - `unknown_code` when no row holds it,
  `retired_code` when the row is inactive - then patches only `mcc_code` on the profile row (insert
  with the lost-race fallback to update), mirrors the `category` step into STEP 079's
  `onboarding_progress` row (creating it on the step after `category` for a merchant who went
  straight to the form), and appends one `merchant_category.saved` audit entry with
  `{code, cleared, complete, saved_at}`.
- **`app/api/onboarding/merchant-category/route.ts`** - `POST` only: CSRF token first, then the
  declared 1 KiB ceiling, then the session, then the JSON parse, then the service. The company never
  comes from the body; a 422 carries `{field, rule}` details; the answer is `no-store`.
- **`app/(dashboard)/onboarding/category/`** - the page (server: session, service read, four
  separate refusals, `SessionKeeper`) and the form (client: a filter input narrowing a native
  `select` over the service's option list, the chosen line, the saved line, per-rule refusal
  sentences, focus to the select on refusal). No HTML `required`, because clearing the field is a
  legitimate save. The wizard card links here through `ONBOARDING_STEP_FORMS`.
- **"In onboarding and profile settings"** is satisfied by storage, not by two forms: the code lives
  once on `business_profiles.mcc_code`, the row the profile settings screens read and edit, so the
  onboarding category form and any profile settings surface can never disagree. The merchant
  dashboard has no settings page yet (a later STEP owns it); see "Known limitation".

## Behaviour Proof (acceptance checklist)

| Acceptance sentence | Where it is proved |
| --- | --- |
| MCC dropdown in merchant onboarding | `/onboarding/category` renders the select over the active codes; the wizard's category card links to it via `ONBOARDING_STEP_FORMS` (asserted in `checkCategorySources`); dev smoke 200 |
| ... and in profile settings | the one stored field is `business_profiles.mcc_code`; the save writes only that column, asserted key-exact in `checkCategorySave` |
| The code is a published code | FK to `mcc_codes (code)` in 0104 (PGlite proof) plus the service's `unknown_code` refusal; 981 seeded codes intact after rollback |
| Retired codes cannot be newly chosen | service rule `retired_code` (gate); the FK keeps an old choice valid (PGlite: retiring `0742` leaves the stored row readable) |
| Four digits, leading zeros kept | `MCC_CODE_PATTERN`, `0104`'s check constraint, PGlite proof (`0742` stored, `123`/`54a1`/`54111` refused) |
| Validation on client and server | server parse in `checkCategoryParse`; the form sends `{ mcc_code }` only and maps each rule to a sentence |
| Save is a patch | update carries exactly `{ mcc_code }`, asserted in `checkCategorySave`; STEP 080's fields are never rewritten |
| Clearing works | empty string answers null, writes `mcc_code: null`, unfinishes the step, audit `cleared: true` |
| The wizard's category step finishes exactly when a code is stored | `checkCategorySave`: onboarding row created opening on `website` with `completed_steps: ["category"]`, and dropped again on clear |
| Auditable | one `merchant_category.saved` entry per save with `{code, cleared, complete, saved_at}`, asserted in `checkCategorySave` |
| UI checks | desktop-width markup exercised in the dev smoke; the select is the native control, so keyboard navigation is the browser's; copy is in the catalog for light/dark themes; mobile width is the same single-column layout as `/onboarding/business` (a person should still confirm at 360 px on staging) |
| API checks | dev smoke: POST without a token 422 `csrf_token_invalid`, with a wrong token 422, GET on the POST-only route 405; gate: all eight refused actors get `PERMISSION_DENIED` with zero queries, writes and audit entries; cross-tenant read answers the other company's own empty state |

## Security proof

- The company is the session's: `requireAnyRole(actor, ONBOARDING_OWNER_ROLES)` + `requireCompanyId`
  run before the first query, and the gate asserts no query, no write and no audit for each of the
  eight refused actors (six office roles, an owner with no company, nobody).
- CSRF: the path is on `CSRF_PROTECTED_PATHS`; `checkCategorySources` asserts the route checks the
  token before it reads the session and the body, bounds the body at 1 KiB, and takes no company
  from the caller; the form sends one fetch with one CSRF spread (the auth gate counts both).
- RLS: `business_profiles` stays default-deny from 0103; `mcc_codes` keeps 0077's policies, so a
  browser role can only ever see active rows, and the service reads the vocabulary with the service
  role key anyway - the dropdown payload carries active codes and titles only, no risk tiers.
- The refusal a client sees is `{field, rule}` with the platform's own envelope; no value is echoed
  back.
- The audit sink failing does not fail the save (asserted), and an unreadable stored instant is
  `INTERNAL_ERROR` rather than "no category chosen" (asserted).

## Verification

- `node services/kyc/verify.ts` -> **944 checks** (6 steps, 1 role, 7 business fields, 5 processors,
  `business_profiles` table, `mcc_codes` vocabulary).
- `node lib/auth/verify.ts` -> **2467 checks** (9 session keepers, 23 browser mutation files, 26
  call sites). `npm run -s check:i18n` -> 1169 messages, 110 placeholders. `node lib/security/verify.ts`
  -> 2376 checks. `npm run -s check:errors` -> 202. `npm run -s check:shell` -> 420.
  `npm run -s check:structure` -> 265 source files. `npm run -s check:migrations` -> 3027 / 104 / 78.
  `npm run -s check:config`, `check:logger`, `check:jobs`, `check:lint`, `check:env` all pass.
- `npm run -s verify` -> **exit 0** (every gate, `tsc --noEmit`, `eslint .`, and `next build`), with
  `/onboarding/category` and `/api/onboarding/merchant-category` in the build's route list.
- PGlite migration proof: `/tmp/proof/proof104.mjs` -> **24 checks passed**, including the rollback.
- Dev smoke on port 3107: `GET /onboarding` 200, `GET /onboarding/category` 200 (signed-out state
  renders "Sign in with a merchant account to choose the category code."), `POST
  /api/onboarding/merchant-category` with no token 422 `csrf_token_invalid`, with a wrong token 422,
  `GET` on the POST-only route 405.

## Known limitation, recorded rather than hidden

- "Profile settings" has no screen of its own yet: the merchant dashboard contains only onboarding
  so far, and the settings screens are a later STEP's owned paths. The field is stored once on the
  profile row, which is what makes the title's two surfaces one field rather than two; when the
  settings STEP lands it edits `business_profiles.mcc_code` through this same service.
- The retired-code rule is the service's (`is_active` changes without a migration, so a constraint
  cannot see it cheaply), while the foreign key deliberately keeps an already-stored retired code
  valid. The two rules are stated in the 0104 header so the asymmetry is a decision, not a gap.
- The dropdown ships all active codes in one payload (981 rows in production, about 60 KiB) and the
  filter is client-side. That is one query, no loop, and fine at the published list's size; if the
  list ever grows materially, the follow-up is a paginated search endpoint, not a bigger payload.
- The gate cannot prove PostgREST is reachable, that `0104` was applied to a particular project, or
  that a person can use the form at two widths - the deployment checks below cover those.

## Deployment checks a person runs

1. Apply `0104_merchant_category_code.sql` to the project (migration gate count goes to 104) and run
   `0104_merchant_category_code.down.sql` on a scratch project; confirm `mcc_code` is gone and
   `mcc_codes` still holds 981 rows.
2. Sign in as an `owner` with a company, open `/onboarding`, press "Open the form" on the category
   card, filter the list, choose `5411 - Grocery Stores, Supermarkets`: the row shows
   `mcc_code = '5411'`, one audit entry `merchant_category.saved` names the code, and the wizard's
   category step is finished (position moves to `website` if it was on `category`).
3. Save `9999`: 422 `unknown_code`. Save `541`: 422 `invalid_format`. Clear the field: `mcc_code` is
   null again and the category step is no longer finished.
4. Have `compliance_kyc` retire the code (set `is_active = false` on `mcc_codes`), reload the form:
   the stored choice still shows its title but is absent from the dropdown, and saving it again is
   422 `retired_code`.
5. Sign in as an office role and open `/onboarding/category`: the refusal sentence, no form; POST the
   route: 403.

## Next

- **Next STEP number:** 082 - "Business address and contact information section".
- **Anything the next chat must know:** its columns go on the same `business_profiles` row through
  migration `0105`, and the patch semantics of STEP 080 (`saveBusinessProfile`) and STEP 081
  (`saveMerchantCategory`) already keep the two screens' saves from overwriting each other - 082 must
  follow the same one-route-per-section pattern, add `address: "/onboarding/address"` to
  `ONBOARDING_STEP_FORMS`, and never rewrite `mcc_code`. The refusal pattern, the four page states and
  the lost-insert-race fallback in `services/kyc/merchant-category.ts` are the template to copy.
