// path: docs/planning/STEP_028_SUBSTEP_BREAKDOWN.md
# STEP 028 - Sub-Step Breakdown

The owner asked for three sub-steps, with an approval between each, so this document is sub-step
028.1 and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_028_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 028 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for KYC submissions, documents, UBO records, sanctions screening records,
  policy acceptances and review decisions tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 003 created `users` (the applicant and the reviewers), STEP 001 `companies`
  (the merchant under review), STEP 027 the payout bank account whose holder name a KYC check
  compares, and STEP 029 the sub-merchant provisioning record that a final approval triggers.
  The KYC screens, the Jumio, Didit and Sumsub adapters, the document storage adapter, the SAR
  case file export and the 7 year retention job are code STEPs.

### Feature list lines that fix the shape
- Section 3: the platform publishes twelve policies - KYC and KYB, UBO (owners of 25 percent or
  more), AML and CFT, sanctions and PEP (OFAC, UN, EU and United States lists), underwriting,
  merchant acceptance, chargeback, refund and settlement, fraud and risk, data privacy, PCI-DSS
  and automated decision review "with human review and appeal path".
- Section 3: "SAR information is visible only to compliance_kyc and super_admin and is never
  disclosed to the related merchant."
- Section 4: "One person holds exactly one account", duplicate checks at signup, at KYC
  submission and before sub-merchant creation, over the signals "email, phone, identity document
  number hash, tax id, bank account fingerprint, legal name with date of birth".
- Section 5: "KYC runs in Manual mode while none of Jumio, Didit or Sumsub is connected"; a
  connected provider "becomes the default verification method"; an incomplete or unsuccessful
  automatic verification "moves to Manual review"; "Large or high-risk merchants require two
  reviewers (four-eye review)"; "Final approval by CEO or super_admin triggers automatic
  sub-merchant account creation"; "Every KYC decision is audit logged".
- Section 5: address verification uploads are "utility bill issued within 3 months, bank
  statement, source of funds document, and any extra document a processor requests".
- Section 13: "Closed and suspended account data and sub-merchant records are retained for 7
  years".
- Section 21 (role table): `compliance_kyc` owns KYC review, underwriting criteria, sanctions
  and PEP screening work and SAR case preparation.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with
  RLS enabled and a default-deny policy.

### What exists today (measured before coding)
- 47 migrations, 47 tables, 47 policies, 82 triggers, 40 functions in `public`; gate 1413
  checks.
- `users` carries `company_id`, `full_name`, `email`, `password_hash` and its own sign-in
  columns; the reviewers of a submission are rows there, and the four-eye rule can therefore be
  a check that two person ids differ.
- `payout_bank_accounts` (STEP 027) carries `account_holder` and `account_fingerprint`, which is
  what a KYC check compares a business name against.
- `audit_logs` (STEP 013) is the append-only, hash chained record a KYC decision is written to
  by the service that makes it; this STEP stores the decision itself and leaves the audit row to
  the service.
- Nothing here stores a file: the storage adapter of sections 100-105 owns bytes, so a document
  row carries a storage key, a hash and its metadata.

## 2. Design Decisions Taken Before Coding

1. **Six tables, one per word of the title.** `kyc_submissions`, `kyc_documents`, `ubo_records`,
   `sanctions_screenings`, `policy_acceptances` and `review_decisions`, with no merged table and
   no column that hides a second meaning.
2. **A submission is a cycle, not a column on the merchant.** One open submission per merchant
   through a partial unique index, with the statuses `draft`, `submitted`, `in_review`,
   `approved` and `rejected`. A merchant that resubmits after a rejection starts a new row, and
   the old row stays as history, which is what an audit reads.
3. **The method is recorded, not guessed.** Section 5 runs manual KYC while no provider is
   connected and switches to the connected one, so `verification_method` is `manual`, `jumio`,
   `didit` or `sumsub`, and a row verified by a provider carries that provider's reference. An
   automatic check that failed says so without telling the merchant which method ran, because
   the status column is the only thing the merchant reads.
4. **Four-eye review is a shape, not a policy.** `first_reviewer_id` and `second_reviewer_id`
   are foreign keys into `users`, and a check refuses the same person twice while an approval
   requires both. Large and high-risk merchants therefore cannot be approved by one click,
   whatever the screen does.
5. **A document is evidence, never a replacement.** `kyc_documents` carries the storage key, the
   SHA-256 of the bytes, the mime type and the size, a type from a closed vocabulary of the
   uploads section 5 names, an issue instant for the three month rule and an expiry, plus the
   reviewer's decision and its reason. The file itself is never a column and the row is
   append-only in the sense that its bytes and its key never change after upload.
6. **A UBO is a share in basis points.** `ubo_records` stores `ownership_bps` and refuses 0 and
   anything above 10000, the policy of owners of 25 percent or more is a flag the compliance
   step sets (`is_significant`, with a check that it is true exactly at 2500 or above), and a
   trigger refuses a submission whose owners add up to more than 10000. The identity document is
   a hash, never a number.
7. **Sanctions screening is a row per subject and list set.** `sanctions_screenings` names its
   subject (a merchant, a UBO or a person), the four lists of section 3 as booleans, the result
   (`clear`, `possible_match`, `confirmed_match`), the provider and the instant. A confirmed
   match requires a note, and the SAR flag marks the case file only `compliance_kyc` and
   `super_admin` may read; the permissive policy of that rule is STEP 035's job.
8. **Policy acceptance is an evidence row per version.** `policy_acceptances` stores the policy
   key from the twelve of section 3, the version text, the SHA-256 of the accepted text, the
   person and the instant, unique per merchant, policy and version, so accepting policy version
   3 twice is one row and accepting version 4 is a second.
9. **A review decision is the audit record, and an appeal is a second decision.**
   `review_decisions` names the subject, the decision (`approve`, `reject`, `request_documents`,
   `escalate`, `overturn`, `uphold`), the person, the instant and the reason, and it points at
   the decision it appeals through a self foreign key; a decision is append-only, so a reversal
   is a new row rather than an edit.
10. **Every table is default-deny** and every table carries the row metadata trigger and a guard
    where an identity must not change.

## 3. The Schema This Produces

### `0048_kyc_submissions.sql`
`company_id`, `verification_method`, `status`, `submitted_at`, `submitted_by`,
`first_reviewer_id`, `second_reviewer_id`, `reviewed_at`, `decided_at`, `decision_reason`,
`provider_reference`, `high_risk`, `four_eye_required`, `expires_at` and the six audit columns.
Checks: the method and the status vocabularies, one open submission per merchant, an approval
with two distinct reviewers and their instant, a rejection with its reason, and a provider
reference only on a provider method.

### `0049_kyc_documents.sql`
`submission_id`, `document_type`, `storage_key`, `content_sha256`, `content_type`, `byte_size`,
`issued_at`, `expires_at`, `status`, `reviewed_at`, `reviewed_by`, `rejection_reason` and the
audit columns. Checks: the type and status vocabularies, a hash of 64 hex characters, a positive
size, the three month rule for a utility bill checked at review, a rejection with its reason,
and a reviewed decision with its person.

### `0050_ubo_records.sql`
`submission_id`, `full_name`, `date_of_birth`, `country`, `ownership_bps`, `is_significant`,
`id_document_sha256`, `is_pep`, `screened_at` and the audit columns. Checks: the share bounds,
the 25 percent flag, the country shape, a hash for the identity document, and a trigger that the
owners of one submission add up to at most 10000 basis points.

### `0051_sanctions_screenings.sql`
`company_id`, `subject_kind`, `subject_id`, `ofac_checked`, `un_checked`, `eu_checked`,
`us_checked`, `result`, `provider`, `screened_at`, `note`, `sar_case` and the audit columns.
Checks: at least one list checked, the subject and result vocabularies, a confirmed match with
its note, and one screening per subject, list set and instant.

### `0052_policy_acceptances.sql`
`company_id`, `policy_key`, `policy_version`, `document_sha256`, `accepted_at`, `accepted_by`
and the audit columns. Checks: the twelve key vocabulary, a version of 1 to 40 characters, a 64
hex hash, one acceptance per merchant, policy and version, and the acceptance instant not in the
future.

### `0053_review_decisions.sql`
`company_id`, `subject_kind`, `subject_id`, `decision`, `decided_by`, `decided_at`, `reason`,
`appeal_of_id`, `appeal_state` and the audit columns. Checks: the subject, decision and appeal
vocabularies, an appeal that names a decision of the same merchant and cannot name itself, an
`overturn` or `uphold` only on an appeal, and the append-only guard.

## 4. The Three Sub-Steps

### 028.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list and the STEP 027 handoff; measured the schema; fixed the design
above. No file outside this document is touched. It stops for permission.

### 028.2 - `0048_kyc_submissions.sql`, `0049_kyc_documents.sql`, `0050_ubo_records.sql`
The submission, its evidence and its owners, with their checks, guards, indexes, comments, RLS
and policies; then a proof that applies `0001` to `0050`, exercises every rule including the
four-eye and the 10000 basis point sum, and runs the rollbacks and the re-apply.

### 028.3 - `0051_sanctions_screenings.sql`, `0052_policy_acceptances.sql`,
`0053_review_decisions.sql`, the docs, the verification and the commit The screening, the
acceptances and the decisions; then the proof for all three, the gate probes, the behaviour
probes, the two README patches, `npm run verify`, the handoff file and the single commit "STEP
028: Migration for KYC submissions, documents, UBO records, sanctions screening records, policy
acceptances and review decisions tables" with its push.

## 5. Files This STEP Owns
- `migrations/0048_kyc_submissions.sql` and `0048_kyc_submissions.down.sql`
- `migrations/0049_kyc_documents.sql` and `0049_kyc_documents.down.sql`
- `migrations/0050_ubo_records.sql` and `0050_ubo_records.down.sql`
- `migrations/0051_sanctions_screenings.sql` and `0051_sanctions_screenings.down.sql`
- `migrations/0052_policy_acceptances.sql` and `0052_policy_acceptances.down.sql`
- `migrations/0053_review_decisions.sql` and `0053_review_decisions.down.sql`
- `migrations/README.md` (six inventory rows and up to three rules)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_028_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_028_COMPLETED.md`
- Not owned and not touched: `0001` to `0047`, every `lib/` module, `config/`, the environment
  contract, the KYC screens, the Jumio, Didit and Sumsub adapters, the document storage adapter,
  the duplicate check service, the SAR export, the retention job, the permissive RLS policies
  (035) and every code STEP.
