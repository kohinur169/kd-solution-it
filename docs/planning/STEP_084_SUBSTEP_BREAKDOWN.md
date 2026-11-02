// path: docs/planning/STEP_084_SUBSTEP_BREAKDOWN.md
# STEP 084 - KYC document upload with UBO capture and sanctions and PEP screening execution and result record: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 084.1 - Confirm there is no migration

- The four tables already exist since STEP 028: `0048` kyc_submissions (the draft), `0049`
  kyc_documents (six-type vocabulary, storage_key regex, sha256, byte_size 1..52428800,
  utility_bill requires issued_at and expires_at after it), `0050` ubo_records (bps 1..10000,
  is_significant = bps >= 2500 enforced by a check, total <= 10000), `0051` sanctions_screenings
  (subject company -> subject_id = company_id, at least one of the four list flags,
  result clear|possible_match|confirmed_match, provider manual default).
- The only new write the STEP needs is the draft row itself, and it is find-or-create on
  (company_id, status = draft): the insert carries `onConflict=company_id,status` semantics through
  the service, so a retry after a partial failure never raises a unique violation and never needs
  a rollback proof.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78 tables; the handoff states
  this explicitly.

## 084.2 - The shared document-type vocabulary (`services/kyc/kyc-document-types.ts`)

- `KYC_DOCUMENT_TYPES` - the six 0049 values in display order - lives in its own module with no
  server imports, because the browser form needs the list for its select options and a "use client"
  component may only `import type` from a server service module (Turbopack rejects the value
  import). `kyc-capture.ts` re-exports it so the service side keeps a single source.

## 084.3 - The capture service (`services/kyc/kyc-capture.ts`)

- `parseKycDocumentInput` / `parseUboInput`: Zod both sides, plain functions returning
  `{ values, problems }` with `{ field, rule }` pairs the routes turn into 422 details. A present
  but unparseable date reports `invalid_format` once; a missing one reports `required` - never
  both. The utility_bill rule keys off issued_at being absent, not off the parse result.
- `saveKycDocument`: owner actor only, `kyc_document` upload policy of `lib/security/upload.ts`
  (pdf/jpeg/png, ceiling 52428800) enforced again server-side, bytes read once into a buffer for
  the sha256 and never stored - only `storage_key = ${companyId}/kyc/${uuid}` and the hash land
  in 0049. A quarantine verdict from the scanner is thrown as `file_not_acceptable` before any
  row is written. One audit entry `kyc_document.uploaded` per accepted document.
- `saveUbo`: bps 1..10000, `is_significant` recomputed from `SIGNIFICANT_OWNER_BPS` (2500) rather
  than trusted, running total of the draft's UBOs + this one must be <= 10000, audit
  `ubo.captured`.
- `runKycScreening`: writes one 0051 row per subject - the company itself (subject_id =
  company_id, per 0051's check) and every UBO of the draft. Provider `manual`, all four list
  flags true, result `possible_match` when the subject's country of record is in the sanctioned
  list of `0076` (CU/IR/KP/SY), else `clear`; the reason goes in `note`, `sar_case` stays false
  (only the office can raise it). Each UBO's `screened_at` is stamped. Audit `kyc_screening.ran`.
  **The result rows are never returned to the merchant**: `readKycPack` carries only
  `screenedCount` - the merchant UI says "screened", never "clear"/"possible_match".
- `readKycPack`: owner-scoped reads of 0048/0049/0050 plus the platform country list (the only
  query not keyed by company_id) and `screenedCount` from 0051; every query is filtered by the
  session's company, never by the row's.

## 084.4 - The three routes

- `app/api/onboarding/kyc-document/route.ts` (multipart formData, File -> arrayBuffer, ceiling
  KYC_DOCUMENT_MAXIMUM_BYTES + 1 MiB read guard), `kyc-ubo/route.ts` and `kyc-screening/route.ts`
  (JSON). All three: CSRF check first, then a body-length ceiling, then actor, then the service,
  then `Cache-Control: no-store` JSON. All three paths are in the CSRF allowlist of
  `lib/security/csrf.ts`. GET on any of them is 405.

## 084.5 - The page

- `app/(dashboard)/onboarding/documents/page.tsx` (server): `readOwnerActor`, `readKycPack`,
  `SessionKeeper`, four states (loading / signed out / ready / error) matching the sibling
  onboarding pages.
- `documents-form.tsx` ("use client"): two literal `method: "POST"` fetch sites sharing one
  `postJson` helper, each spreading `...(await csrfHeaders())` exactly once (the auth gate counts
  spreads vs POST calls 1:1), the multipart upload path for documents, UBO add/list with the bps
  share line, and the screening button. All strings from the `onboardingDocuments` block of
  `en.ts` via `formatMessage`; `import type` only from the service, value import only from
  `kyc-document-types.ts`.
- `step-copy.ts` maps the `documents` step to `/onboarding/documents`.

## 084.6 - Verification

- `services/kyc/verify.ts` grew the kyc-pack section: vocabulary, both parsers, owner scoping of
  every query (the country-list read excluded explicitly), document save incl. quarantine,
  UBO total ceiling and significant-owner recompute, screening rows (company + sanctioned-country
  UBO -> possible_match with note, four flags, provider manual, sar_case false, merchant-hidden
  pack), and source probes. Gate: 1844 checks, exit 0.
- `lib/auth/verify.ts` baselines: 12 session keepers, 25 browser mutation files, 29 CSRF call
  sites. Gate: 2483 checks, exit 0.
- `npm run -s check:i18n` 1310 messages / 122 placeholders; structure 280 files; shell 450;
  errors 202; config 28; lint 77; migrations 3057 / 105 / 78; security 2376; `npm run -s lint`
  and `npm run -s typecheck` clean; `npm run -s verify` (all gates + production build) exit 0,
  the build listing `/onboarding/documents` and the three `kyc-*` routes.
- Dev smoke on port 3107: `GET /onboarding/documents` 200 with the signed-out sentence; POST to
  each route without a token and with a wrong token -> 422 `csrf_token_invalid`; GET on each
  route -> 405.
