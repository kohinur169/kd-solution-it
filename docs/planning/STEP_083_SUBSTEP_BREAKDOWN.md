// path: docs/planning/STEP_083_SUBSTEP_BREAKDOWN.md
# STEP 083 - One-time business profile that feeds every processor: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 083.1 - Confirm there is no database part

- Section 5's "merchant sets business information once; the same information is sent to every
  connected processor" is a *read* over the storage STEPs 080-082 already built: one
  `business_profiles` row (0103 + 0104 + 0105), the code vocabulary of 0077, the country list of
  0076. A second table or a stored payload would be a copy that drifts the first time a provider
  changes what it asks for.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations; the gate reads the full row
  shape (all 0103/0104/0105 columns) through the fake store.

## 083.2 - The payload service (`services/submerchant/processor-profile.ts`)

- `readProcessorProfile({ actor, companyId? }, deps)`: the owner reads their own company (a foreign
  `companyId` parameter is `PERMISSION_DENIED` before any query); `super_admin`/`ceo`/`compliance_kyc`
  read any one merchant by a UUID-validated `companyId` (anything else is `VALIDATION_FAILED` before
  any query) and every such read appends one `processor_profile.read_by_office` audit entry, with the
  audit sink failing tolerated. One bounded row read, then at most two reference reads (the code's
  title from `0077`, the country's name from `0076`) in parallel.
- `snapshotOf`: business values, category with title, address block, country name, per-processor
  coverage from the `processor-fields.ts` matrix, `businessMissing`/`addressMissing`, the flat
  `blocking` list (`business.<field>`, `category.mcc_code`, `address.<field>`) and `ready` derived
  from the values - never from the stamps, which are only reported beside it.
- `processorPayloadFor(snapshot, provider)`: pure per-provider payload - the provider's required
  business fields plus the optional ones that are present, the category, all nine address and
  contact fields, the country name - and its own `missing` list.
- `assertProvisionable`: no row is `RESOURCE_NOT_FOUND`; a row with missing facts is
  `VALIDATION_FAILED` naming each one, which is the error the provisioning job surfaces.
- **Proof:** the profile sections of `services/kyc/verify.ts` over the fake store: roles, scoping,
  the two reference reads, the office audit entry, empty/partial/full rows, retired code and
  disabled country still resolving their names, the broken-instant `INTERNAL_ERROR`, the payload
  per provider, and the provisioning refusal.

## 083.3 - The route (`app/api/onboarding/processor-profile/route.ts`)

- GET only: session from the cookie, `companyId` from the query string for the office roles, service,
  `no-store`. No CSRF check (a read has no body), so the path is deliberately not on
  `CSRF_PROTECTED_PATHS`.
- **Proof:** the source section of the gate plus the dev smoke (401 without a session, 405 on POST).

## 083.4 - The review page (`app/(dashboard)/onboarding/review/`)

- Server component, read-only (no inputs: every field belongs to its own step's form), four page
  states, `SessionKeeper`, field labels reused from the `onboardingBusiness`/`onboardingAddress`/
  `onboardingCategory` catalogs, per-processor coverage lines reusing `onboardingBusiness.coverage*`,
  templated lines through `formatMessage`. `ONBOARDING_STEP_FORMS` gains `review: "/onboarding/review"`.
- **Proof:** the catalog section of the gate plus the dev smoke (200, signed-out sentence).

## 083.5 - Gates, baselines and the record

- `services/kyc/verify.ts` grew from 1277 to 1469 checks and its summary names the submerchant profile.
- `lib/auth/verify.ts` baselines: 11 session keepers (the review page added), mutation files and
  CSRF call sites unchanged (the review page sends no POST).
- `lib/i18n/strings/en.ts` gained the `onboardingReview` block (19 strings, 5 placeholders;
  1219 -> 1238 messages, 113 -> 118 placeholders).
- `npm run -s verify` exit 0; `app/(dashboard)/README.md` updated; this breakdown and the handoff
  are in the same commit.

## What the next STEP inherits

- `services/submerchant/processor-profile.ts` is the one call a provisioning job makes per
  connected processor: `readProcessorProfile` once per company, then `processorPayloadFor(snapshot,
  provider.key)` per provider, and `assertProvisionable` before anything is sent. `0054`'s
  `submerchant_provisions` row records the *result* of that call, never the payload itself.
- The review step of the wizard is now linked and read-only; STEP 087's submission summary can read
  the same snapshot instead of re-assembling it.
