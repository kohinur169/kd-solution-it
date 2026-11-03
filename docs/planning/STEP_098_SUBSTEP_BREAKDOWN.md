// path: docs/planning/STEP_098_SUBSTEP_BREAKDOWN.md
# STEP 098 - Duplicate identity check at signup, KYC and provisioning stages: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 098.1 - The database part: `0110_duplicate_cases.sql` plus its rollback

- FEATURE_LIST section 4 "One Person, One Account": duplicate checks run at signup, at KYC
  submission and before sub-merchant creation; the signals are email, phone, identity document
  number hash, tax id, bank account fingerprint, legal name with date of birth; a match blocks the
  new account and sends the case to compliance_kyc review.
- `0110` stores the CASE a match opens, not the check: one row per matched signal of one applicant at
  one stage - `stage` in (signup, kyc_submission, provisioning), `signal` in the six section 4 names,
  `matched_company_id` / `matched_user_id` naming the existing account, status `open` then `resolved`
  with reviewer + instant + trimmed resolution (locked by the guard, which also refuses delete and
  soft delete). At the signup stage the blocked applicant has no company yet, so the case is filed
  under the matched tenant. Partial unique index `duplicate_cases_open_unique` on (company_id,
  stage, signal) where open - a repeated check converges. Open queue index (compliance reads oldest
  first), per-company history index, RLS default-deny.
- `npm run -s check:migrations`: 3197 -> 3229 checks, **109 -> 110 migrations, 83 -> 84 tables**.

## 098.2 - The checker service (`services/kyc/duplicate-check.ts`)

- Constants: `DUPLICATE_CASES_TABLE`, `DUPLICATE_CASE_ENTITY = "duplicate_case"`,
  `DUPLICATE_CASE_OPENED_AUDIT_ACTION = "duplicate_case.opened"`, `IDENTITY_SIGNALS` (the six),
  `DUPLICATE_STAGES` (signup, kyc_submission, provisioning), `DUPLICATE_IDENTITY_RULE =
  "duplicate_identity"`.
- `collectIdentitySignals(companyId, rest)`: one bounded read per source table - users (email,
  phone), business_profiles (contact_phone, tax_id, legal_name), ubo_records (id_document_sha256,
  full_name + date_of_birth as the composite signal), payout_bank_accounts (account_fingerprint) -
  and turns them into signal values.
- `checkDuplicateIdentity({companyId, stage, actor?}, deps)`: every signal is matched in one
  `Promise.all` batch - each a single `select id, company_id ... <column>=eq.<value> ... deleted_at
  is null limit 10` against the source table, then rows of the applicant's own company are filtered
  out in code (no `neq` needed, no per-row queries over other tenants' data). Each matched signal
  becomes one open `0110` case via `recordCase` (pre-reads the open case for company + stage +
  signal, so a repeat converges; insert otherwise), audited `duplicate_case.opened`. Returns
  `{ blocked, matches }` - the matches never leave the service in an applicant-facing answer.
- `checkSignupIdentity({email}, deps)`: the signup-stage entry point - the email is the only section
  4 signal present before an account exists (`0003`'s unique email already answers it
  indistinguishably at the provider). A match records the case under the matched tenant with
  `actorUserId: null` and answers blocked.
- Ownership note: the signup route and `lib/auth/registration.ts` are auth-block files, so the
  signup-stage wiring ships as this exported entry point; the two block-owned stages are wired
  directly (below). Recorded in the handoff as the ownership boundary of the title.

## 098.3 - The two block-owned wirings and the applicant-facing copy

- `services/kyc/kyc-capture.ts` `submitKyc`: after the missing-documents/screening checks and before
  the conditional status update, the check runs at stage `kyc_submission`; a match throws CONFLICT
  with `[{ field: "identity", rule: "duplicate_identity" }]` - generic, never the signal.
- `services/submerchant/provision.ts` `runSubmerchantProvisioning`: after the approved-status check
  and before any provider read, the check runs at stage `provisioning`; a match returns
  `{ ..., created: 0, skipped: 0, queuedWithoutMasterAccount: 0, blocked: true }` (`blocked` is a new
  field of `ProvisionRunSummary`; the unblocked path answers `blocked: false`).
- `app/(dashboard)/onboarding/status/status-form.tsx` maps the `duplicate_identity` rule;
  `lib/i18n/strings/en.ts` gains `onboardingStatus.ruleDuplicateIdentity` ("An account with these
  details already exists on the platform, ...") - the section 4 sentence the applicant reads.
  i18n gate 1522 -> 1523 messages.

## 098.4 - The gate (`services/kyc/verify.ts`)

- The fake store learned the `users`, `payout_bank_accounts` and `duplicate_cases` reads (generic eq
  filters, limit, defaults), a `duplicate_cases` insert branch, a cross-company signal read on
  `business_profiles` (contact_phone / tax_id), a generic eq filter in the shared KYC branch, and
  default seeded rows (companies, the owner user of COMPANY_A). `BusinessRowShape` gained an optional
  `id`.
- `checkMigrationSet` now expects 0110 and max 110.
- `checkDuplicateIdentityGate()` (3703 -> 3773 checks): vocabulary; signal collection (email,
  phone x2, tax_id, hash, name+dob, fingerprint); no-match run is not blocked and writes nothing;
  full match run is blocked with one open case per matchable signal (the email is unique so it
  cannot match across accounts), each naming COMPANY_B, the phone case naming the matched user, one
  audit per case; a repeated check converges without new cases or audits; the signup stage blocks on
  a registered email with the case under the matched tenant and a null actor, passes a fresh email,
  and refuses a malformed one; `submitKyc` on a duplicate conflicts `duplicate_identity`, leaves
  the submission a draft and leaves the cases queued; `runSubmerchantProvisioning` on a duplicate
  returns `blocked: true` with zero inserts and a provisioning-stage case, while the unblocked run
  still provisions two rows with `blocked: false`.
- `checkDuplicateIdentitySources()` scans the checker, both wirings and the migration pair.
