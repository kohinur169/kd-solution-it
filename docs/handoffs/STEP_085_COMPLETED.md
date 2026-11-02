// path: docs/handoffs/STEP_085_COMPLETED.md
# STEP 085 - Address proof upload: utility bill with 3 month issue rule: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 085 code are in one commit, the
one whose message is "STEP 085: Address proof upload: utility bill with 3 month issue rule"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_084_COMPLETED.md`.

## STEP

- **Number and title:** STEP 085 - Address proof upload: utility bill with 3 month issue rule
  (`docs/final/STEP_PLAN_250.md`, the STEP 085 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Seventh STEP of the block.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/` (plus the `app/api/onboarding/` routes the onboarding block has owned
  since STEP 083). This STEP touched only the first two; no `app/api/` change was needed.
- **Feature list:** section 5 - "Address verification uploads: utility bill issued within 3
  months, bank statement, source of funds document, and any extra document a processor requests."
- **Depends on:** STEP 084 (`services/kyc/kyc-capture.ts` and its document upload), STEP 028
  (`0049` kyc_documents, whose checks already cover issue-date presence, ordering and
  no-future-dates).

## No migration - and why that needs no rollback proof

`0049` already constrains `issued_at`/`expires_at` at the row level (required on a utility bill,
`expires_at > issued_at`, `issued_at <= created_at`). The three month window is an upload-time
business rule, not a row constraint: the office must be able to accept a re-issued bill, and
"today" is only meaningful when the upload happens. So this STEP adds no migration;
`npm run -s check:migrations` stays at 105 migrations / 78 tables, and there is no new write path
that a rollback would have to undo - the rule only refuses, it never writes.

## Files

- **Created:** `docs/planning/STEP_085_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_085_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-document-types.ts` (`UTILITY_BILL_MAX_AGE_MONTHS = 3`,
  `utilityBillIssueWindow(nowMs)`, the `UtilityBillIssueWindow` type - all client-safe),
  `services/kyc/kyc-capture.ts` (re-exports; `parseKycDocumentInput` takes `{ now }` and enforces
  the rules; `saveKycDocument` pins the request's clock; the absent-vs-unparseable double-report
  is fixed), `app/(dashboard)/onboarding/documents/page.tsx` (computes the window once at module
  scope and passes it as the `issueWindow` prop), `documents-form.tsx` (picker `max`, client
  pre-check, per-field 422 errors, templated rule line, two new rule sentences),
  `lib/i18n/strings/en.ts` (4 new keys in `onboardingDocuments`: `docTypeHint`,
  `utilityBillRuleLine`, `ruleInvalidDate`, `ruleInvalidRange`; 1310 -> 1314 messages),
  `services/kyc/verify.ts` (1844 -> 1877 checks), `app/(dashboard)/README.md` (the documents
  bullet names the rule).

## Behaviour

- **Server (authoritative):** a document with a parseable `issued_at` later than today is refused
  with `{ field: "issued_at", rule: "invalid_date" }` for every type - `0049` would refuse the row
  anyway, and the service refuses it earlier with the field named. A **utility bill** whose
  `issued_at` is earlier than today minus 3 calendar months is refused with
  `{ field: "issued_at", rule: "invalid_range" }`. The window is inclusive at both ends: at
  2026-11-02 a bill dated 2026-08-02 is accepted, 2026-08-01 is refused. Other document types are
  not bound by the window (a bank statement dated 2020-01-01 parses). A sent-but-unparseable date
  is reported once as `invalid_format`, never also as `required`.
- **Client (early answer only):** the page computes `utilityBillIssueWindow(Date.now())` once at
  module scope (the react-hooks purity rule forbids `Date.now()` during render) and passes it as
  `issueWindow`; the form caps the date picker at `issueWindow.latest` and refuses a stale or
  future utility-bill date locally before any fetch. Every 422 detail is now shown beside its
  field, not just the file one.
- The upload route, the audit entry, the storage-key-and-hash record and the wizard step sync
  from STEP 084 are unchanged.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 1877 checks: window helper boundary and year-crossing, boundary
  bill accepted, one-day-stale refused `invalid_range`, future refused `invalid_date` on a bill
  and on an identity document, old bank statement date accepted, unparseable date reported once,
  a full `saveKycDocument` at the boundary recording `issued_at = 2026-08-02`, the two new save
  refusals writing nothing and querying nothing, and source probes on service, types module,
  page and form.
- `node lib/auth/verify.ts` - 2483 checks, baselines unchanged (12 keepers / 25 mutation files /
  29 call sites; the form still has exactly two `method: "POST"` sites with one awaited CSRF
  spread each).
- `npm run -s check:i18n` - 1314 messages / 123 placeholders; `npm run -s lint` clean;
  `npm run -s typecheck` clean; `npm run -s verify` (structure, shell, errors, config, lint,
  migrations, security, logger, jobs gates + production build) exit 0 - the build still lists
  `/onboarding/documents` and `/api/onboarding/kyc-document`.
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `GET
  /onboarding/documents` -> 200 with the signed-out sentence; POST `/api/onboarding/kyc-document`
  with no token -> 422 `{"field":"csrf","rule":"csrf_token_invalid"}`; GET on the route -> 405.

## Notes for the next STEP

- STEP 086 (bank statement and source of funds upload) reuses the same upload route and parser;
  the bank statement period is an underwriting criterion the compliance team sets (section 5), so
  it will arrive as a parameter, not as a hard-coded window - do not generalize
  `utilityBillIssueWindow` into a per-type rule table yet.
- The window helper compares date-only strings lexically; keep any future date rule on the same
  YYYY-MM-DD shape so the comparison stays correct.
