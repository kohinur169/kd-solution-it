// path: docs/handoffs/STEP_104_COMPLETED.md
# STEP 104 - KYC document storage category with tenant isolation paths: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 104 code are in one commit, the
one whose message is "STEP 104: KYC document storage category with tenant isolation paths"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_103_COMPLETED.md`.

## STEP

- **Number and title:** STEP 104 - KYC document storage category with tenant isolation paths
  (`docs/final/STEP_PLAN_250.md`, line 1320, "File Storage Layer" block).
- **Category:** File Storage Layer, STEPs 100-105. Fifth STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP added `lib/storage/kyc.ts` and edited `types.ts` (the default bucket), `verify.ts`,
  `README.md`, plus this handoff. Read-only imports from `lib/security/upload.ts` (the magic byte
  validator), `lib/auth/*`, `lib/errors/app-error.ts`; the `0049` document types are mirrored, not
  imported, because `lib/` never imports `services/` (the gate asserts the mirror against
  `services/kyc/kyc-document-types.ts` source).
- **Feature list:** section 21 "File Storage" (lines 227-229: magic byte verification, size
  limits, short-lived signed downloads with audit, "KYC documents ... can be uploaded") and the
  tenant separation of section 30 that `0057`'s `files_tenant_path_check` encodes.
- **Depends on:** STEPs 100-103 (`lib/storage/` port, adapters, encryption, record service),
  `0057`/`0058` (`files`), `0049` (the six KYC document types), `0070` (tenant RLS),
  `lib/security/upload.ts` (`validateUpload` verdicts, `UPLOAD_POLICIES`).
  No migration, no routes, no UI - the category is a lib/storage service the routes of the
  onboarding block call.

## What was built

- `lib/storage/kyc.ts` - the KYC document category:
  - **Tenant isolation paths:** keys are `<companyId>/kyc/<documentType>/<uuid><ext>`, built by
    `kycStorageKey` (tenant prefix + `kyc` segment + `0049` document type + fresh UUID + the
    extension of the *verified* type; the browser's file name is display only). `parseKycStorageKey`
    reads the layout back and `assertKycKeyForCompany` refuses a key whose first segment is not
    exactly the asking merchant's id - on the read path too, so a well formed key of another tenant
    is refused in code even though the `0057` constraint already guards the write. `..` traversal
    was already refused by the port's key validation.
  - `uploadKycDocument(deps, input)` - the category in one call: `validateUpload` magic-byte verdict
    (a rejected upload - svg, empty, over the limit, wrong type - is a `422` and stores *nothing*),
    then `uploadEncryptedObject` (seal + adapter + `file.uploaded` audit), then
    `recordUploadedFile` (`0057` row, `file.recorded` audit), then the verdict walks the row:
    `markFileVerified` -> `ready`, or `quarantineFile` with the reason -> `quarantined`. Returns
    `{ record, stored, sealed, verdict }`.
  - `createKycDownloadUrl(deps, { companyId, fileId, expiresInSeconds? })` - the section 21
    short-lived signed URL: the record must be a `kyc_document` row of this merchant (purpose check
    + `assertKycKeyForCompany`), and `pending`/`quarantined` are refused with `PERMISSION_DENIED` -
    a lying file is never served. The signed-URL access is audited (`file.accessed`,
    operation `signed_url`).
  - `readKycDocument` - the server-side download: record + tenant check, `downloadEncryptedObject`
    (decrypts under the tenant scope), returns the plaintext.
  - `archiveKycDocument` - retires a row (status walk `ready -> archived`).
  - `KYC_DOCUMENT_TYPES` mirrors `0049`'s six types; the gate reads `services/kyc/kyc-document-types.ts`
    and asserts every mirrored name appears there.
- `types.ts` - `DEFAULT_STORAGE_BUCKET = "kd-solution-it-files"`, the same name `.env.example`
  sets `S3_BUCKET` to, so the S3 adapter's configured-bucket pin and the default agree.
- `verify.ts` - extended from 333 to **388 checks**: key layout/parser/tenant refusals, the
  end-to-end flows against the fake adapter + in-memory `files` store + real encryption - verified
  PDF lands `ready` with `file.uploaded`/`file.recorded`/`file.verified` audit entries, a PNG
  declared as PDF lands `quarantined` with reason and `.png` key, an SVG upload is a 422 with zero
  inserts and zero adapter calls, signed URLs honour default/custom TTL, quarantined ->
  `PERMISSION_DENIED`, foreign tenant -> `RESOURCE_NOT_FOUND`, logo row -> `VALIDATION_FAILED`,
  server-side read returns the exact plaintext, archive walks forward.
- `README.md` - the `kyc.ts` row and rule 9 (pending/quarantined never served).

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 388 checks, 2 adapter names (supabase + s3
  wired), 5 error codes, files sealed aes-256-gcm (master-v1), 7 purposes, kyc category with tenant
  paths, signed urls 300s default / 900s max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  334 files, config, i18n 1608, logger, error, lint, shell, jobs 110, migrations 3261/111/85, kyc
  4142, auth 2543, build - all baselines unchanged).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/` 200, `/api/jobs/health` 200,
  `/api/onboarding/kyc-document` and `/api/onboarding/account-close` 422 without csrf; server
  killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## Next STEP

STEP 105 (line 1332): the logo and branding asset storage category on the same pattern -
`company_logo` purpose, image-only policies (PNG/JPEG/WebP, 2 MB), key layout
`<companyId>/logo/<uuid><ext>`, upload flow and branding download URLs.
