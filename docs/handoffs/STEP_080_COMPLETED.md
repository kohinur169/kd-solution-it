// path: docs/handoffs/STEP_080_COMPLETED.md
# STEP 080 - Business information form driven by processor required fields: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `4bdacc0`. Previous handoff:
`docs/handoffs/STEP_079_COMPLETED.md`.

## STEP

- **Number and title:** STEP 080 - Business information form driven by processor required fields
  (`docs/final/STEP_PLAN_250.md`, the STEP 080 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  Second STEP of the block, and the first that collects data.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`.
- **Feature list:** section 5 - "Business information form follows the connected processor
  requirements and changes per processor. Merchant sets business information once on the platform.
  The same information is sent to every connected processor."
- **Depends on:** STEP 079 (`0102_onboarding_progress.sql`, `services/kyc/onboarding-steps.ts`,
  `app/(dashboard)/onboarding/owner-actor.ts`), STEP 056 (`lib/auth/rest.ts`), STEP 057
  (`lib/security/csrf.ts`, `lib/security/csrf-client.ts`), STEP 006/089-era gateway registry
  (`lib/gateways/registry.ts` - the five provider keys, which this STEP imports rather than
  re-listing), STEP 001 (`0001_companies.sql` - the tenant root and `set_row_metadata`).

## Files

- **Created:** `migrations/0103_business_profiles.sql`,
  `migrations/0103_business_profiles.down.sql`, `services/kyc/processor-fields.ts`,
  `services/kyc/business-profile.ts`, `app/api/onboarding/business-profile/route.ts`,
  `app/(dashboard)/onboarding/business/page.tsx`,
  `app/(dashboard)/onboarding/business/business-form.tsx`,
  `docs/planning/STEP_080_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_080_COMPLETED.md`.
- **Modified:** `services/kyc/verify.ts` (the onboarding gate grew the STEP 080 sections: matrix,
  parse, read, save, refusals, sources and catalog; 345 -> 660 checks), `lib/i18n/strings/en.ts`
  (the `onboardingBusiness` block, 39 strings, plus `onboarding.actionOpenForm`),
  `lib/security/csrf.ts` (one path on the protected list: `/api/onboarding/business-profile`),
  `lib/auth/verify.ts` (session keeper count 7 -> 8, browser mutation files 21 -> 22, call sites
  24 -> 25), `app/(dashboard)/onboarding/step-copy.ts` (`ONBOARDING_STEP_FORMS` and
  `onboardingStepFormHref`), `app/(dashboard)/onboarding/onboarding-wizard.tsx` (a card now links to
  the step's own form when one exists).
- **Not touched:** `package.json`, `package-lock.json`, every other migration, every other STEP's
  files.

## Database

- **Migration:** `0103_business_profiles.sql` (and its `.down.sql`). One live row per merchant
  company holding the seven business facts of section 5: `legal_name` (2-120, trimmed),
  `trading_name` (1-120, trimmed), `business_type` (`individual` | `company`),
  `registration_number` (2-40, trimmed), `tax_id` (2-40, trimmed), `website` (`https://`, 9-300),
  `business_description` (10-1000, trimmed), plus `completed_at`.
- **Why one row and not five copies:** section 5 says the merchant fills the information once and the
  platform sends it to every connected processor. Each adapter STEP (147-169) reads the columns it
  needs from this row; nothing is duplicated per provider, so two processors cannot be told two
  different legal names by a merchant who edited one screen.
- **Constraints the database keeps on its own:** `business_profiles_company_key` (partial unique on
  `company_id where deleted_at is null`, so a company has one live profile and a soft-deleted row can
  be replaced), `business_profiles_completed_check` (a row cannot claim `completed_at` without the six
  facts every processor requires), `business_profiles_completed_instant_check`,
  `business_profiles_website_check` (`https://%`), `business_profiles_type_check`,
  `business_profiles_tenant_key`, a `set_row_metadata` trigger for `updated_at`/`version`, and
  default-deny RLS - no browser role reads a tax identifier directly.
- **Proof:** `/tmp/proof/proof103.mjs` (PGlite 0.5.14, outside the repository) applied `0103` over a
  stubbed `companies` and `set_row_metadata`, exercised the draft row, the one-live-row index, the
  completion check, the business-type check, the https check, the trimmed-name check, the
  soft-delete-then-replace path, a negative control that dropped
  `business_profiles_completed_check` and then wrote the row it had refused, and the rollback:
  **12 checks passed**. The rollback drops the policy, the trigger, the index and the table, and
  creates nothing.
- **Migration gate:** `npm run -s check:migrations` -> **3006 checks, 103 migrations, 78 tables**.

## Environment

No new variable. The form reads nothing from the environment; the route uses the same
`getAuthRuntime()` the STEP 079 route uses.

## Packages

No package added or changed. `package.json` and `package-lock.json` are untouched.

## What was built

- **`services/kyc/processor-fields.ts` - the matrix.** `BUSINESS_PROFILE_FIELDS` (the seven facts, in
  the form's order), `PROCESSOR_REQUIREMENTS` keyed by the five registry providers (NMI: legal name,
  business type, website, description; Payoneer: legal name, business type, tax id; Rainforest: legal
  name, business type, registration number, tax id, website; Stripe Connect: legal name, business
  type, tax id, website; Airwallex: legal name, **trading name**, business type, registration number,
  website), `PROCESSOR_REQUIREMENT_LIST` in the registry's order, and the computed
  `REQUIRED_BUSINESS_FIELDS` / `OPTIONAL_BUSINESS_FIELDS`. This is what makes the form "change per
  processor": the required set is the union, so a field appears required when any connected processor
  demands it, and the panel beside the form shows each processor's own list and what it is still
  missing.
- **`services/kyc/business-profile.ts` - the save and the read.** `readBusinessProfile` answers the
  caller's own company (row or empty draft); `saveBusinessProfile` is a patch: a field the body does
  not mention keeps its stored value, an empty string clears it, and completion is recomputed from the
  merged whole. Every field has a server-side rule (length, format, `https` only, the two business
  types) and a refusal names **every** field that failed with its rule. Completion stamps
  `completed_at` once, mirrors the `business` step into STEP 079's `onboarding_progress` row (creating
  it on the next step for a merchant who went straight to the form), and appends one
  `business_profile.saved` audit entry with `{fields, complete, completed_now, missing, saved_at}`.
  A lost insert race falls back to the update it would have been.
- **`app/api/onboarding/business-profile/route.ts`** - `POST` only: CSRF token first, then the
  declared byte ceiling (8 KiB), then the session, then the JSON parse, then the service. The company
  never comes from the body; a 422 carries `{field, rule}` details so the form can mark every bad box.
- **`app/(dashboard)/onboarding/business/`** - the page (server: session, service read, four separate
  refusals) and the form (client: the seven inputs, a required badge per field, per-field refusal
  sentences, the per-processor coverage panel, the missing-field summary, save state and the "last
  saved" line). Fields are drawn from `BUSINESS_PROFILE_FIELDS`; no field list is repeated in the
  markup. Nothing carries the HTML `required` attribute, because a draft must be saveable.
- **The wizard** now renders an "Open the form" link on a card whose step has a form; the map is
  `ONBOARDING_STEP_FORMS` in `step-copy.ts`, which grows as the later STEPs land.

## Behaviour Proof (acceptance checklist)

| Acceptance sentence | Where it is proved |
| --- | --- |
| The form follows the connected processor's required fields | `checkBusinessMatrix`: five processors, every required/optional field drawn from the seven, required sets compared to the documented lists field by field |
| And changes per processor | the panel renders each processor's own list and its own missing fields; Airwallex is the one row that includes the trading name, Payoneer the one row without a website |
| The merchant enters business information once | one table, one live row per company (`business_profiles_company_key`), one form, one route; the adapters of STEPs 147-169 read columns |
| The same information is sent to every connected processor | `PROCESSOR_REQUIREMENT_LIST` is built from `PLATFORM_PROVIDERS`, and `checkBusinessMatrix` asserts the order matches the registry, so a provider cannot be missing from the panel |
| Validation per processor requirement | `checkBusinessParse` (too short, too long, unknown key, wrong type, non-https website, unknown business type, whitespace collapse, empty clears) and `business_profiles_*_check` constraints in `0103` |
| Auditable | one `business_profile.saved` entry per save naming the company, the fields, the completion state and the instant; asserted in `checkBusinessSave`, including `completed_now` |

## Security proof

- The company is the session's: `requireCompany` asks `owner` + `requireCompanyId` before the first
  query, and `checkBusinessRead` / `checkBusinessSaveRefusals` run all eight refused actors
  (six office roles, an owner with no company, nobody) and assert **no query, no write and no audit**
  for each.
- CSRF: the path is on `CSRF_PROTECTED_PATHS`; `checkBusinessSources` asserts the route checks the
  token **before** it reads the session and that no company is taken from the caller.
- RLS is default-deny, so the tax identifier is not readable by any browser role.
- The refusal a client sees is `{field, rule}` with the platform's own envelope; no value is echoed
  back.
- The audit sink failing does not fail the save (`checkBusinessSaveRefusals` asserts a stored row with
  a throwing trail), and an unreadable stored instant is `INTERNAL_ERROR` rather than an empty profile
  - a defect must not read as "the merchant never filled this in".

## Verification

- `node services/kyc/verify.ts` -> **660 checks** (6 steps, 1 role, 7 business fields, 5 processors,
  `business_profiles` table).
- `node lib/auth/verify.ts` -> 2463 checks (8 session keepers, 22 browser mutation files, 25 call
  sites). `node lib/i18n/verify.ts` -> 1137 messages, 107 placeholders. `node lib/security/verify.ts`
  -> 2376 checks. `node lib/errors/verify.ts` -> 202 checks. `npm run -s check:shell` -> 409 checks.
  `npm run -s check:structure` -> 261 source files. `npm run -s check:migrations` -> 3006 / 103 / 78.
- `npm run -s typecheck` clean; `npx eslint` on every file this STEP touched clean.
- `npm run -s verify` exit 0 (all gates, typecheck, lint and `next build`), with
  `/onboarding/business` and `/api/onboarding/business-profile` in the route list.
- Dev smoke on port 3105: `GET /onboarding` 200, `GET /onboarding/business` 200 (signed-out state
  renders "Sign in with a merchant account to fill in the business information."),
  `POST /api/onboarding/business-profile` with no token 422 `csrf_token_invalid`, with a wrong token
  422, `GET` on the POST-only route 405.

## Known limitation, recorded rather than hidden

- `0103`'s `business_profiles_completed_check` requires six facts and not `trading_name`, while the
  service's required set includes it (Airwallex). The service is therefore **stricter** than the
  constraint: a complete profile always satisfies the database, and no write can fail because of the
  difference. Loosening the service to match the constraint would let a profile be marked complete
  that Airwallex would refuse, so the difference stays and is stated here.
- `REQUIRED_BUSINESS_FIELDS` currently contains all seven fields, so the form marks every field
  required and `OPTIONAL_BUSINESS_FIELDS` is empty. That is the union rule working as designed, not a
  bug: the moment Airwallex is removed from the registry, `trading_name` becomes optional by
  computation.
- The form is one page with a fixed order; the per-processor difference is shown as a coverage panel
  and the required badges, not as a form that renumbers itself per processor. Section 5's sentence is
  satisfied by the field set and the validation, and a reordering form would make the same profile
  harder for a merchant to fill.
- The gate cannot prove PostgREST is reachable, that `0103` was applied to a particular project, or
  that a person can fill the form at two widths.

## Deployment checks a person runs

1. Apply `0103_business_profiles.sql` to the project and confirm `business_profiles` exists with 78
   tables in the gate's count; run `0103_business_profiles.down.sql` on a scratch project and confirm
   the table is gone.
2. Sign in as an `owner` with a company, open `/onboarding`, press "Open the form" on the business
   card, and save one field: the row appears, `completed_at` stays null, and an audit entry
   `business_profile.saved` names that field.
3. Fill all seven fields: the row's `completed_at` is stamped, and `/onboarding` shows the business
   step finished with the position on `address`.
4. Clear the tax identifier: `completed_at` returns to null and the wizard's business step is no longer
   finished.
5. Sign in as an office role and open `/onboarding/business`: the refusal sentence, and no form.

## Next

STEP 081 - "Merchant Category Code (MCC) dropdown or input in merchant onboarding and profile
settings" (migration `0104`, `mcc_codes` of `0077` is the vocabulary it reads). The category step of
the wizard is its form, and `ONBOARDING_STEP_FORMS` is where its address goes.
