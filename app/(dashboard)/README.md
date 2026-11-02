// path: app/(dashboard)/README.md
# app/(dashboard)

Owner: STEP 079-126 (merchant onboarding and business core), with later payment screens.

The merchant owner area: onboarding and business profile, underwriting and
KYC submission, clients, products, invoices, estimates, recurring invoices, payment links,
settlement statements, payout settings and account settings.

Every read is scoped to the caller company and every write is audit logged.

## What exists

- `onboarding/` - STEP 079: the section 5 wizard shell, its six steps and the saved position
  (`0102_onboarding_progress.sql`, `services/kyc/onboarding-progress.ts`,
  `POST /api/onboarding/progress`). The forms each step collects are the STEPs that follow it.
- `onboarding/business/` - STEP 080: the business information form, the first of those forms
  (`0103_business_profiles.sql`, `services/kyc/processor-fields.ts`,
  `services/kyc/business-profile.ts`, `POST /api/onboarding/business-profile`). The wizard links to it
  through `ONBOARDING_STEP_FORMS` in `onboarding/step-copy.ts`, and each later form adds its address
  to that map.
- `onboarding/category/` - STEP 081: the merchant category code form
  (`0104_merchant_category_code.sql` adds `business_profiles.mcc_code`, pointing at the published
  code list of `0077_mcc_codes.sql`; `services/kyc/merchant-category.ts`,
  `POST /api/onboarding/merchant-category`). The code is stored once on the business profile row, so
  onboarding and profile settings share the one field.

## The reader

`onboarding/owner-actor.ts` is this area's one account reader: one cookie read, one directory read,
one session read per request, memoised with `cache()`. Every later merchant screen imports it rather
than reading the cookie again, the same way the office area shares `app/(admin)/office-actor.ts`.
