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
- `onboarding/status/` - STEP 087: the KYC submission summary and status screen - the merchant-safe
  summary (`readKycSummary`: status, counts, decision reason; never the verification method, a
  provider reference, a screening result or a storage key) and the submit that moves the draft to
  `submitted` (`submitKyc`, conditional update + audit; `POST /api/onboarding/kyc-submit`).
- `onboarding/kyc-review/` - STEP 088: the compliance KYC review queue with document viewer - the
  office side of `0048`-`0051` in `services/kyc/kyc-review.ts` (queue of submitted/in_review rows,
  full detail with storage keys, hashes and screening results, `kyc_review.read_by_office` audit per
  read; `openKycReview` moves submitted to in_review; `reviewKycDocument` accepts/rejects one
  document with the reason 0049 demands; `GET /api/onboarding/kyc-review`, `/kyc-review-submission`,
  `POST /api/onboarding/kyc-review-open`, `/kyc-document-review`). The screen lives under the
  onboarding block's owned path and gates on the office roles through the service; merchants keep
  the 087 summary screen, which never carries method, provider reference, screening results or
  storage keys. STEP 089 adds the four-eye flow on the same service:
  `markKycSubmissionRisk` (high risk forces `four_eye_required`; decided rows are locked and
  conflict; `POST /api/onboarding/kyc-risk-mark`), the queue badges four-eye rows, and
  `fourEyeProblems` is the guard STEP 093's decision flow calls before writing a decision.
- `onboarding/underwriting/` - STEP 090: the underwriting criteria screen for the compliance team
  (`0106_underwriting_criteria.sql` creates the one `underwriting_criteria` row and the three
  `underwriting_risk_tiers` rows, plus the office read policy on `business_profiles` for the MCC
  overview; `services/kyc/underwriting.ts` reads and writes them: `readUnderwritingSettings` and
  `readUnderwritingMccOverview` for the ceo/compliance_kyc/finance_ops/super_admin read roles,
  `updateUnderwritingCriteria`, `updateUnderwritingRiskTier` and `setMccRiskTier` for the
  super_admin/compliance_kyc manage roles, each a conditional version-bumped update with a re-read
  race check and its own audit action, and `readMerchantUnderwritingSummary` answering the owner the
  one criterion that governs their upload - the required bank statement period, which the documents
  route now enforces server side. `POST /api/onboarding/underwriting-criteria`,
  `/underwriting-risk-tier`, `/underwriting-mcc-tier`, `GET /api/onboarding/underwriting-mcc`).
- STEP 091 enforces the criteria's starting limit per merchant: `0107_merchant_transaction_limits.sql`
  holds one row per company (assigned `monthly_limit`, UTC `month_key`, `used_amount`, with the
  `used_amount <= monthly_limit` check as the database backstop); `services/kyc/merchant-limit.ts`
  creates the row lazily from `underwriting_criteria` on first read (audited `merchant_limit.assigned`),
  and `checkTransactionAgainstLimit` / `recordTransactionUsage` are the per-transaction enforcement the
  payment core will call (CONFLICT `monthly_limit_exceeded`, month rollover, conditional version-bumped
  updates, `merchant_limit.usage_recorded` audit; money as BigInt minor units, no float);
  `updateMerchantLimit` is the office's raise/lower (`POST /api/onboarding/merchant-limit-set`);
  `GET /api/onboarding/merchant-limit` serves the merchant's own limit, shown on the status screen.

## The reader

`onboarding/owner-actor.ts` is this area's one account reader: one cookie read, one directory read,
one session read per request, memoised with `cache()`. Every later merchant screen imports it rather
than reading the cookie again, the same way the office area shares `app/(admin)/office-actor.ts`.
