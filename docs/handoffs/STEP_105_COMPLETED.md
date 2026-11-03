// path: docs/handoffs/STEP_105_COMPLETED.md
# STEP 105 - Logo and branding asset storage category: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 105 code are in one commit, the
one whose message is "STEP 105: Logo and branding asset storage category" (`git log -1` on the
branch shows its hash). Previous handoff: `docs/handoffs/STEP_104_COMPLETED.md`. This is the last
STEP of the File Storage Layer block (100-105).

## STEP

- **Number and title:** STEP 105 - Logo and branding asset storage category
  (`docs/final/STEP_PLAN_250.md`, line 1332).
- **Category:** File Storage Layer, STEPs 100-105. Sixth and last STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP added `lib/storage/branding.ts` and edited `types.ts` (the shared
  `STORAGE_EXTENSION_BY_CONTENT_TYPE` / `storageExtensionFor`, now used by both categories),
  `kyc.ts` (switched to the shared extension map), `verify.ts`, `README.md`, plus this handoff.
  Read-only imports from `lib/security/upload.ts`, `lib/auth/*`, `lib/errors/app-error.ts`.
- **Feature list:** section 21 line 229 ("logos ... can be uploaded") and line 184 ("Merchants can
  set their own logo and invoice branding"); the `company_logo` policy of
  `lib/security/upload.ts` (PNG/JPEG/WebP only, 2 MB ceiling, svg refused).
- **Depends on:** STEPs 100-104 (port, adapters, encryption, record service, KYC category as the
  pattern), `0057`/`0058` (`files`), `0070` (tenant RLS). No migration, no routes, no UI.

## What was built

- `lib/storage/branding.ts` - the logo and branding asset category, mirroring the KYC category:
  - **Tenant isolation paths:** keys are `<companyId>/logo/<uuid><ext>`, built by
    `brandingStorageKey` (tenant prefix + `logo` segment + fresh UUID + extension of the *verified*
    type). `parseBrandingStorageKey` / `assertBrandingKeyForCompany` enforce the tenant on the read
    path, exactly like `kyc.ts`.
  - `uploadBrandingAsset(deps, input)` - the category in one call: `validateUpload` against the
    `company_logo` policy (svg and the 2 MB+ upload are `422` and store nothing; a mismatched type
    is stored and quarantined with the reason), encrypted upload, the `0057` row, the verdict's
    status walk - and when the upload verifies, the merchant's previous live logo rows are archived
    (`ready -> archived`), so **one merchant has one current logo**; older objects stay as history
    under their own keys. Returns `{ record, stored, sealed, verdict, archived }`.
  - `createBrandingDownloadUrl(deps, { companyId, fileId?, expiresInSeconds? })` - the short-lived
    signed URL: without a `fileId` it is the merchant's current logo (newest `ready`, else newest
    `archived`); a `pending`/`quarantined` asset is refused with `PERMISSION_DENIED`, a foreign
    tenant gets `RESOURCE_NOT_FOUND`, a non-logo row `VALIDATION_FAILED`. Access audited
    (`file.accessed`, operation `signed_url`).
  - `currentBrandingAsset(deps, { companyId })` - the current logo record, with the tenant key
    check, or `RESOURCE_NOT_FOUND`.
- `types.ts` - `STORAGE_EXTENSION_BY_CONTENT_TYPE` / `storageExtensionFor` shared by both
  categories (pdf/jpg/png/webp; svg and containers get none and are refused before this point).
- `verify.ts` - extended from 388 to **433 checks**: key layout/parser/tenant refusals, extension
  map; end-to-end against the fake adapter (s3 this time) + in-memory `files` store + real
  encryption: verified PNG lands `ready` under `<companyId>/logo/...`, a second verified logo
  archives the first and becomes `currentBrandingAsset`, download URLs (current/by-id, default and
  custom TTL), quarantined -> `PERMISSION_DENIED`, no-logo merchant -> 404, svg -> 422, 2 MB+1 ->
  422 with zero stored rows, kyc row -> `VALIDATION_FAILED`.
- `README.md` - the `branding.ts` row and the block-complete note.

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 433 checks, 2 adapter names (supabase + s3
  wired), 5 error codes, files sealed aes-256-gcm (master-v1), 7 purposes, kyc + branding
  categories, signed urls 300s default / 900s max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  335 files, config, i18n 1608, logger, error, lint, shell, jobs 110, migrations 3261/111/85, kyc
  4142, auth 2543, build - all baselines unchanged).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/` 200, `/api/jobs/health` 200,
  `/api/onboarding/kyc-document` 422 without csrf, `/onboarding/documents` 200,
  `/onboarding/account` 200 signed out; server killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## The block, complete

`lib/storage/` now has the whole section 21 layer: `types.ts` (port + vocabulary + bounds),
`registry.ts` (active adapter by env), `http.ts` + `supabase-adapter.ts` + `s3-adapter.ts` +
`adapters.ts` (both providers, env-selected), `encryption.ts` + the encrypted operations in
`service.ts` (AES-256-GCM before upload, audited), `records.ts` (the `0057` file record),
`kyc.ts` and `branding.ts` (the two categories with tenant-isolated paths), and `verify.ts`
(433 checks, `node lib/storage/verify.ts`). Next block: STEP 106 (clients, products, invoices).
