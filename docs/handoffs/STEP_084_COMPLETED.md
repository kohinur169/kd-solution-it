// path: docs/handoffs/STEP_084_COMPLETED.md
# STEP 084 - KYC document upload with UBO capture and sanctions and PEP screening execution and result record: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 084 code are in one commit, the
one whose message is "STEP 084: KYC document upload with UBO capture and sanctions and PEP
screening execution and result record" (`git log -1` on the branch shows its hash). Previous
handoff: `docs/handoffs/STEP_083_COMPLETED.md`.

## STEP

- **Number and title:** STEP 084 - KYC document upload with UBO capture and sanctions and PEP
  screening execution and result record (`docs/final/STEP_PLAN_250.md`, the STEP 084 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Sixth STEP of the block; the first that writes KYC facts.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `app/api/onboarding/`,
  `services/kyc/`, `services/submerchant/`. This STEP writes inside the first three and reads none
  of `services/submerchant/`.
- **Feature list:** section 8/9 - KYC documents uploaded by the merchant, ultimate beneficial
  owners captured with ownership percentages, sanctions/PEP screening run and its result
  recorded for the compliance office.
- **Depends on:** STEP 028 (`0048`-`0051`, the four tables), STEP 054/056-057 (`lib/auth/rest.ts`,
  CSRF), the `kyc_document` upload policy of `lib/security/upload.ts`, `0076` (sanctioned
  countries CU/IR/KP/SY), STEP 079 (`services/kyc/onboarding-steps.ts` step vocabulary), STEP 083
  (`readOwnerActor`, the review step that this STEP's page links onward from).

## No migration - and why that needs no rollback proof

The tables exist since STEP 028 (`0048` kyc_submissions, `0049` kyc_documents, `0050` ubo_records,
`0051` sanctions_screenings), so this STEP adds **no migration**; `npm run -s check:migrations`
stays at 105 migrations / 78 tables. The one write that could race - creating the draft
submission - is find-or-create on (company_id, status = draft) with an upsert-style conflict
target, so a retried request reuses the draft instead of raising a unique violation; there is
therefore no partial-write path that a rollback would have to undo, and no rollback proof is
required. This is stated here per the STEP's handoff rules.

## Files

- **Created:** `services/kyc/kyc-document-types.ts` (client-safe six-type vocabulary),
  `services/kyc/kyc-capture.ts` (the whole capture service), `app/api/onboarding/kyc-document/route.ts`,
  `app/api/onboarding/kyc-ubo/route.ts`, `app/api/onboarding/kyc-screening/route.ts`,
  `app/(dashboard)/onboarding/documents/page.tsx`,
  `app/(dashboard)/onboarding/documents/documents-form.tsx`,
  `docs/planning/STEP_084_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_084_COMPLETED.md`.
- **Modified:** `lib/security/csrf.ts` (the three new POST paths in the token allowlist),
  `app/(dashboard)/onboarding/step-copy.ts` (`documents: "/onboarding/documents"`),
  `lib/i18n/strings/en.ts` (the `onboardingDocuments` block, ~66 strings incl. the templated
  size/share/screened lines rendered via `formatMessage`), `services/kyc/verify.ts` (the kyc-pack
  section: 1469 -> 1844 checks; summary line now ends "kyc pack"), `lib/auth/verify.ts`
  (baselines: 12 session keepers, 25 mutation files, 29 CSRF call sites), `app/(dashboard)/README.md`
  (the documents bullet).

## Behaviour

- **Document upload:** `POST /api/onboarding/kyc-document` takes multipart formData; the server
  re-validates the type against the 0049 vocabulary and the bytes against the `kyc_document`
  policy (pdf/jpeg/png, <= 52428800 bytes; the route reads at most ceiling + 1 MiB and refuses
  beyond it). The file bytes are read once for the sha256 and **never stored** - 0049 keeps only
  `storage_key = ${companyId}/kyc/${uuid}` and the hash. A scanner quarantine verdict is thrown as
  `file_not_acceptable` before any row exists. Audit `kyc_document.uploaded` per accepted file.
  `utility_bill` additionally requires `issued_at`, and `expires_at` must be after it.
- **UBO capture:** `POST /api/onboarding/kyc-ubo` - bps 1..10000, `is_significant` recomputed as
  bps >= 2500 (never trusted from the client), and the draft's existing UBOs plus this one must
  total <= 10000 bps. Audit `ubo.captured`.
- **Screening:** `POST /api/onboarding/kyc-screening` writes one 0051 row per subject: the
  company itself (subject_id = company_id, as 0051's check requires) and every UBO of the draft.
  Provider `manual`, all four list flags (ofac/un/eu/us) recorded true, `result` =
  `possible_match` when the subject's country of record is sanctioned per `0076` (CU/IR/KP/SY),
  else `clear`; the reason is in `note`; `sar_case` stays false - only the office can raise it.
  Each UBO's `screened_at` is stamped. Audit `kyc_screening.ran`. **Result rows are never sent to
  the merchant**: `readKycPack` returns only `screenedCount`, and the UI renders "screened", never
  a verdict.
- **Reads:** `readKycPack` is scoped to the session actor's company on every query - the one
  exception is the platform country list (`countries`), which is not company-keyed. The page
  `GET /onboarding/documents` renders four states (loading / signed out / ready / error) under
  `SessionKeeper`.
- **Routes:** all three POST routes check CSRF first, then a body-length ceiling, then the actor,
  then call the service, and answer `Cache-Control: no-store` JSON; GET on any of them is 405.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 1844 checks, incl. parser edge cases (a nonexistent date is
  refused once, as `invalid_format`), owner-only scoping of every company-keyed query, quarantine
  refusal, the bps ceiling and significant-owner recompute, screening rows with four flags /
  provider manual / sar_case false, and the merchant-hidden pack.
- `node lib/auth/verify.ts` - 2483 checks; 12 keepers, 25 mutation files, 29 call sites; each of
  the form's two POST sites spreads `...(await csrfHeaders())` exactly once.
- `npm run -s check:i18n` - 1310 messages / 122 placeholders; `check:structure` 280 files;
  `check:shell` 450; `check:errors` 202/15; `check:config` 10/28; `check:lint` 77;
  `check:migrations` 3057/105/78; `node lib/security/verify.ts` 2376.
- `npm run -s lint`, `npm run -s typecheck` clean; `npm run -s verify` (all gates + production
  build) exit 0 - the build lists `/onboarding/documents` and `/api/onboarding/kyc-document`,
  `/kyc-ubo`, `/kyc-screening`.
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `GET
  /onboarding/documents` -> 200 with the signed-out sentence; POST to each of the three routes
  with no token and with a wrong token -> 422 `{"field":"csrf","rule":"csrf_token_invalid"}`;
  GET on each route -> 405.

## Notes for the next STEP

- STEP 085 (utility bill with the 3-month issue rule) builds directly on `saveKycDocument`: the
  `issued_at` presence rule is already enforced in `parseKycDocumentInput`; the 3-month freshness
  rule belongs to the same parser when STEP 085 lands.
- The draft find-or-create (`ensureDraftSubmission`) is the row every later KYC STEP reads;
  screening result rows in 0051 are office-visible only - keep it that way.
