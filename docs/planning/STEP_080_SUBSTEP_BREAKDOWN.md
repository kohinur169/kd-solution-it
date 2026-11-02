// path: docs/planning/STEP_080_SUBSTEP_BREAKDOWN.md
# STEP 080 - Business information form driven by processor required fields: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 080.1 - The matrix (`services/kyc/processor-fields.ts`)

- Read section 5's sentence and section 6's provider registry; import `PLATFORM_PROVIDERS` and
  `ProviderKey` instead of writing the five keys again.
- Seven fields in the form's order: legal name, trading name, business type, registration number,
  tax id, website, business description.
- Five per-processor rows of required and optional fields, each justified in the header comment.
- `REQUIRED_BUSINESS_FIELDS` and `OPTIONAL_BUSINESS_FIELDS` computed from the matrix, so removing a
  provider narrows the form.
- **Proof:** the matrix section of `services/kyc/verify.ts`.

## 080.2 - The table (`0103_business_profiles.sql` + rollback)

- One live row per company, seven nullable columns and `completed_at`, so a draft can be saved.
- Constraints: length and trimming per column, `https://` for the website, the two business types, a
  completion rule that refuses a stamp without the facts, an instant rule, `version > 0`.
- `business_profiles_company_key` partial unique index, `set_row_metadata` trigger, default-deny RLS,
  column comments.
- A rollback that drops the policy, the trigger, the index and the table, and creates nothing.
- **Proof:** `npm run -s check:migrations`, then a PGlite run that exercises every constraint and a
  negative control that drops the completion check and writes what it had refused.

## 080.3 - The service (`services/kyc/business-profile.ts`)

- `readBusinessProfile`: the caller's own company, a row or an empty draft, an unreadable instant as
  `INTERNAL_ERROR`.
- `parseBusinessProfileInput`: unknown keys refused, wrong types refused, empty strings clear,
  sanitised and measured per field, every problem collected.
- `saveBusinessProfile`: patch semantics, merged completion, `completed_at` stamped once and cleared
  when a required field goes, the wizard's `business` step mirrored into `0102`, one audit entry, and
  the lost-insert-race fallback.
- **Proof:** the read, save and refusal sections of the gate, over an in-memory PostgREST.

## 080.4 - The route (`app/api/onboarding/business-profile/route.ts`)

- POST only: CSRF token, declared byte ceiling, session, JSON parse, service.
- No company from the body; the response carries the saved values, the per-processor coverage, the
  completion state and the instant.
- Added to `CSRF_PROTECTED_PATHS`.
- **Proof:** the source section of the gate plus a dev smoke for 422 and 405.

## 080.5 - The screen (`app/(dashboard)/onboarding/business/`)

- Page: session through `readOwnerActor`, profile through the service, four separate refusals.
- Form: the seven inputs from the matrix, required badges, per-field refusal sentences, whitespace and
  length handled by the service rather than the browser, the coverage panel, the missing summary, save
  state and the saved instant. Drafts stay saveable, so no HTML `required`.
- The wizard card links to the form through `ONBOARDING_STEP_FORMS`.
- **Proof:** the catalog section of the gate (every string used, every key present) plus a dev smoke.

## 080.6 - Gates, baselines and the record

- `services/kyc/verify.ts` grew from 345 to 660 checks.
- `lib/auth/verify.ts` baselines: 8 session keepers, 22 browser mutation files, 25 call sites.
- `npm run -s verify`, dev smoke, commit, handoff, this file.

## What the next STEP inherits

- `ONBOARDING_STEP_FORMS` in `app/(dashboard)/onboarding/step-copy.ts` - add
  `category: "/onboarding/category"` there when STEP 081 lands, and the wizard links to it.
- `business_profiles` is the row the MCC step will extend or join; `0077_mcc_codes.sql` is the
  vocabulary.
- The refusal pattern of this STEP (four states, per-field details, an audit entry per save) is the one
  STEPs 081-099 copy.
