// path: docs/handoffs/STEP_083_COMPLETED.md
# STEP 083 - One-time business profile that feeds every processor: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 083 code are in one commit, the
one whose message is "STEP 083: One-time business profile that feeds every processor"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_082_COMPLETED.md`.

## STEP

- **Number and title:** STEP 083 - One-time business profile that feeds every processor
  (`docs/final/STEP_PLAN_250.md`, the STEP 083 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  Fifth STEP of the block; the first that reads the stored profile for the processors instead of
  writing it.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`. This STEP creates `services/submerchant/` and uses the first two as
  readers of the constants the earlier STEPs own.
- **Feature list:** section 5 - "Merchant sets business information once on the platform. The same
  information is sent to every connected processor", with "Fields include business name, business
  address, person name, contact information..."; section 6 - each adapter opens a sub-merchant from
  that profile; section 27 - provisioning runs as a background job.
- **Depends on:** STEP 079 (`0102`, `services/kyc/onboarding-steps.ts`), STEP 080 (`0103`,
  `services/kyc/processor-fields.ts` - the per-processor requirement matrix, `business-profile.ts`),
  STEP 081 (`0104`, `merchant-category.ts`, `0077`), STEP 082 (`0105`, `business-address.ts`,
  `business-address-fields.ts`, `0076`), STEP 069 (`0094` seeds the five providers;
  `lib/gateways/registry.ts`), STEP 054 (`0054_submerchant_provisions.sql` - the provisioning rows
  this payload will be written into later), STEP 056-057 (`lib/auth/rest.ts`, CSRF), STEP 001.

## Files

- **Created:** `services/submerchant/processor-profile.ts`,
  `app/api/onboarding/processor-profile/route.ts`,
  `app/(dashboard)/onboarding/review/page.tsx`,
  `docs/planning/STEP_083_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_083_COMPLETED.md`.
- **Modified:** `services/kyc/verify.ts` (the gate grew the profile sections; 1277 -> 1469 checks,
  and the summary names the submerchant profile), `lib/i18n/strings/en.ts` (the `onboardingReview`
  block, 19 strings, 5 placeholders), `app/(dashboard)/onboarding/step-copy.ts`
  (`review: "/onboarding/review"` in `ONBOARDING_STEP_FORMS`), `lib/auth/verify.ts` (baseline: 11
  session keepers; mutation files 24 and CSRF call sites 27 unchanged - the review page sends no
  POST), `app/(dashboard)/README.md` (the review bullet and the `services/submerchant/` note).
- **Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md):** all three:
  `app/(dashboard)/onboarding/`, `services/kyc/` (the gate only), `services/submerchant/`.

## Database

- **Migrations added:** none. The STEP is the read side of the one row STEPs 080-082 stored: no
  column, table or payload is added, because a stored payload would drift from the requirement
  matrix the first time a provider changes what it asks for.
- **Rollback verified on clean database:** not applicable - nothing was applied. The invariant is
  guarded instead: `npm run -s check:migrations` still reports 105 migrations / 78 tables, and the
  gate proves the service reads exactly the 0103+0104+0105 columns through the real row shape.

## Environment

- **Environment variables added to .env.example:** none.
- **Secrets handled:** none new. The provisioning job will call the service with the existing
  service role key; no key material is read here.

## Packages

- **Package requests for the integrator:** none.

## Behaviour Proof (acceptance checklist)

- **"Sets business information once":** all facts live on the one `business_profiles` row; the gate
  asserts `readProcessorProfile` issues exactly one row query (plus at most the code-title and
  country-name lookups) and reads no other table.
- **"The same information is sent to every connected processor":** `processorPayloadFor` computes a
  payload per provider from the shared snapshot - its required business fields plus present optional
  ones, the category with its published title, all nine address/contact fields, the country name -
  and the gate asserts all five providers, in registry order, with the right field subsets (nmi gets
  no tax id; airwallex gets it as optional).
- **Readiness is derived, never posted:** `ready` = every processor-required business field + the
  code + the seven required address fields present; `blocking` names each missing fact as
  `business.<field>` / `category.mcc_code` / `address.<field>`; the 0103 and 0105 completion instants
  are reported beside it. Gate: full row ready with empty blocking; lone legal name not ready with
  14 blocking entries; empty row 15.
- **Provisioning refusal:** `assertProvisionable` - no row is `RESOURCE_NOT_FOUND`; missing facts are
  `VALIDATION_FAILED` with one `{field, rule: "missing_required"}` detail each (gate: 14 details on
  the partial profile); a complete profile passes (gate: no-throw).
- **Roles and scope:** owner reads own company (foreign `companyId` refused before any query); the
  three office roles read any named merchant with a UUID parameter (missing/non-UUID parameter is
  `VALIDATION_FAILED` before any query); support, blogger, an owner without a company and an
  anonymous caller all get `PERMISSION_DENIED` with zero queries (gate).
- **Audit:** every office read appends exactly one `processor_profile.read_by_office` entry on the
  `business_profile` entity naming the merchant, the officer, the tenant chain and the readiness;
  an owner read appends nothing; an audit sink that is down does not fail the read (gate).
- **UI checks:** `/onboarding/review` is a read-only server page (no inputs - each field belongs to
  its own step's form): four page states, business/category/address sections with labels reused from
  the owning steps' catalogs, per-processor coverage lines, the missing-facts line and the saved
  line; desktop width exercised in the dev smoke, mobile is the same single-column layout (confirm at
  360 px on staging); copy in the catalog for light/dark themes.
- **API checks:** dev smoke on port 3107: `GET /onboarding/review` 200 with "Sign in with a merchant
  account to review your onboarding profile."; `GET /api/onboarding/processor-profile` without a
  session 401 `AUTHENTICATION_REQUIRED`, with a bogus cookie 401; `POST` on the GET-only route 405.
  The route is deliberately not on `CSRF_PROTECTED_PATHS` (a read has no body) - asserted by the
  gate, and the auth gate's POST-routes-equal-CSRF-list rule still holds.
- **Money flow ledger proof:** not applicable.
- **Provider sandbox cycle:** not applicable yet - the adapters of STEPs 147-169 and the
  provisioning job (a later STEP) are the consumers; this STEP provides the one call they make.

## Security proof

- The company is either the session's (owner) or an explicitly named, UUID-validated parameter
  (office roles); the gate asserts every refusal happens with zero queries, and the profile query is
  always scoped to exactly one live company row (`company_id=eq...&deleted_at=is.null&limit=1`).
- RLS: the read goes through the service role key over `business_profiles`, `mcc_codes` and
  `countries`, all default-deny with their own policies; no browser role can reach the route's data
  path (the route itself requires a session, and the page is owner-only).
- Office reads of merchant data are audit logged (one entry each, asserted), so a merchant can see
  in section 2's chain who looked at their profile; owner reads of their own profile are not.
- No value from any source is echoed in an error envelope; refusals carry `{field, rule}` only.

## Verification

- Typecheck: `npm run -s typecheck` -> exit 0. Lint: `npm run -s lint` -> exit 0 (0 problems).
- Build: full `npm run -s verify` -> **exit 0** (every gate, tsc, eslint, `next build`), with
  `/onboarding/review` and `/api/onboarding/processor-profile` in the build's route list.
- Gates: `node services/kyc/verify.ts` -> **1469 checks** (6 steps, 1 role, 7 business fields,
  5 processors, `business_profiles` table, `mcc_codes` vocabulary, `countries` list, submerchant
  profile); `node lib/auth/verify.ts` -> 2471 checks (11 session keepers, 24 browser mutation files,
  27 CSRF call sites); `node lib/security/verify.ts` -> 2376 checks;
  `npm run -s check:migrations` -> 3057 checks, 105 migrations, 78 tables;
  `npm run -s check:i18n` -> 1238 messages, 118 placeholders; `check:structure` -> 273 source files;
  `check:shell` -> 435 checks, 113 files; `check:errors` -> 202; `check:config` -> 10/28;
  `check:lint` -> 77; logger 117; jobs 110.
- Migration proof: none needed (no migration); `/tmp/proof/proof105.mjs` from STEP 082 still covers
  the storage this service reads (54 checks).
- Dev smoke on port 3107 (`.env.local` from `.env.example`, removed afterwards): as listed above.

## Known limitation, recorded rather than hidden

- The provisioning job itself is a later STEP (section 27): today `assertProvisionable` and
  `processorPayloadFor` are exercised by the gate, not by a live job. The API route exists so the
  office can preview exactly what a processor would be sent for any merchant.
- The per-processor payload is the *platform's stored shape* mapped per provider, not a provider's
  native schema: each adapter STEP (147-169) maps the fields it needs from these columns when it
  reads the provider's live documentation, the same split `processor-fields.ts` already documents.
- A stored category code or country that has since been retired/disabled still resolves its name on
  read (the write side refuses new ones); that matches STEP 081's rule that an old choice keeps
  naming itself.
- The gate cannot prove PostgREST is reachable or that a person can use the page at two widths - the
  deployment checks below cover those.

## Deployment checks a person runs

1. Sign in as an `owner` who finished the business, address and category steps, open
   `/onboarding`: the review card links to `/onboarding/review`; the page shows all three sections
   and, per processor, "Everything this processor asks for is here."; if a field is missing the page
   names it in the missing-facts line.
2. As `compliance_kyc`, call `GET /api/onboarding/processor-profile?companyId=<merchant uuid>`:
   200 with the assembled snapshot, and one `processor_profile.read_by_office` audit entry; with no
   parameter: 422 `invalid_format` on `company_id`; as `support`: 403.
3. Clear one required field (e.g. the tax id) on the merchant's profile: the review page's
   missing-facts line names it, and the processors that require it show "Still needed: ...".
4. Confirm `npm run -s check:migrations` still reports 105 migrations - this STEP applied none.

## Next

- **Next STEP number:** 084 - "KYC document upload with UBO capture and sanctions and PEP screening
  execution and result record".
- **Anything the next chat must know:** the one-time profile now has a single assembly point -
  `readProcessorProfile` + `processorPayloadFor` in `services/submerchant/processor-profile.ts` -
  and the review page shows it; the document steps should read the same snapshot for the merchant's
  identity facts rather than re-querying `business_profiles`. The provisioning job (section 27,
  after KYC approval) will call `assertProvisionable` then `processorPayloadFor` per connected
  provider and write results into `0054`'s `submerchant_provisions`, keeping the payload out of the
  database. `GET /api/onboarding/processor-profile` is the office preview of that payload and is
  audit logged per read. Owned paths for 084+ remain `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`.
