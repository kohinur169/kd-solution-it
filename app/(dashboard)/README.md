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
  `POST /api/onboarding/progress`). The forms each step collects are the STEPs that follow it;
  `services/submerchant/` holds the read side of that one profile for the processors.
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
- `onboarding/address/` - STEP 082: the registered address and contact person form
  (`0105_business_address.sql` adds the nine address columns to `business_profiles`, with the
  country pointed at `0076`'s enabled countries; `services/kyc/business-address.ts`,
  `POST /api/onboarding/business-address`).
- `onboarding/review/` - STEP 083: the read-only review page of the one profile every processor is
  sent (`services/submerchant/processor-profile.ts` reads the one `business_profiles` row once,
  resolves the code title from `0077` and the country name from `0076`, and computes the payload and
  the readiness per processor; `GET /api/onboarding/processor-profile` for the office roles, which
  audit each read). No migration: the facts were already stored on the profile row by STEPs 080-082.
- `onboarding/documents/` - STEP 084: the KYC documents step - upload, beneficial owners and the
  manual screening run (`services/kyc/kyc-capture.ts` over the `0048`-`0051` tables and the
  `kyc_document` upload policy of `lib/security/upload.ts`; `POST /api/onboarding/kyc-document`,
  `/kyc-ubo`, `/kyc-screening`; the document type list is shared with the browser through
  `services/kyc/kyc-document-types.ts`). No migration either: STEP 028 built the tables. The utility bill carries STEP 085's three month issue rule
  (`utilityBillIssueWindow` in `services/kyc/kyc-document-types.ts`, enforced server-side in
  `parseKycDocumentInput` and pre-checked in the form). A bank statement carries STEP 086's
  period rule: both dates are the covered period, which must end within the last month and span
  the required period (a parameter, default three months, until the office sets the underwriting
  criterion).

## The reader

`onboarding/owner-actor.ts` is this area's one account reader: one cookie read, one directory read,
one session read per request, memoised with `cache()`. Every later merchant screen imports it rather
than reading the cookie again, the same way the office area shares `app/(admin)/office-actor.ts`.
