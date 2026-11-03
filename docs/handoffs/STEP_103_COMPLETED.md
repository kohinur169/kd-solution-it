// path: docs/handoffs/STEP_103_COMPLETED.md
# STEP 103 - File record service storing provider, hash, size and type: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 103 code are in one commit, the
one whose message is "STEP 103: File record service storing provider, hash, size and type"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_102_COMPLETED.md`.

## STEP

- **Number and title:** STEP 103 - File record service storing provider, hash, size and type
  (`docs/final/STEP_PLAN_250.md`, line 1308, "File Storage Layer" block).
- **Category:** File Storage Layer, STEPs 100-105. Fourth STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP added `lib/storage/records.ts` and edited `types.ts` (purpose/status vocabulary),
  `encryption.ts` and `service.ts` (scope validation now uses the storage vocabulary), `verify.ts`,
  `README.md`, plus this handoff. Read-only imports from `lib/auth/rest.ts`, `lib/auth/audit.ts`,
  `lib/errors/app-error.ts`.
- **Feature list:** section 21 "File Storage", line 226 - "Every file record stores
  storage_provider, hash, size, type and company."
- **Depends on:** STEPs 100-102 (`lib/storage/` port, adapters, encryption), migration `0057`
  (the `files` table: tenant-path check `storage_key like company_id||'/%'`, unique
  `files_storage_key`, the forward-only status guard, the quartet checks) as widened by `0058`
  (seven purposes), `0070` (tenant RLS policy), and the `RestClient` of `lib/auth/rest.ts`.
  No new migration, no routes, no UI - STEP 104/105 consume the record service.

## What was built

- `lib/storage/records.ts` - the file record service over the `files` table:
  - `FILE_PURPOSES` (in `types.ts`): the seven purpose names of `0057`+`0058`, now the single
    vocabulary used by the record service and the STEP 102 encryption scope (previously the scope
    validated against the five of `lib/security/upload.ts`; the database check is the authority).
  - `newStorageKey(companyId, purpose)` -> `<companyId>/<purpose>/<uuid>`: tenant prefix by
    construction, passes `validateObjectKey`, unique per upload.
  - `recordUploadedFile(deps, { companyId, uploadedBy, purpose, contentType, stored, sealed })`:
    validates the company id, purpose, uploader, bucket and key, refuses a key outside the
    merchant's own prefix in code (the `0057` check enforces the same at the database), inserts
    the row with provider/bucket/key from the adapter's `StoredObject`, type + plaintext size +
    plaintext SHA-256 + the encryption quartet from the `SealedFile`, status `pending`; a duplicate
    storage key answers `CONFLICT` (one object is one row, forever). Audited `file.recorded` with
    the row id as entity.
  - `getFileRecord` / `listFileRecords`: every select carries `company_id=eq.<id>` (and
    `deleted_at=is.null` for live reads) - service-role calls bypass RLS, so the scoping is in the
    query, and the gate's fake store rejects any unscoped one. Unknown or foreign id ->
    `RESOURCE_NOT_FOUND`.
  - The status walk, mirrored from the `0057` guard before the update is sent: `markFileVerified`
    (pending -> ready, sets `magic_byte_verified` + `verified_at` once), `quarantineFile` (reason
    trimmed, 1..280), `archiveFile`, `softDeleteFile` (`deleted_at` once). Each re-reads the row
    after the update (a PostgREST update matching nothing still reports success), audits
    `file.verified` / `file.quarantined` / `file.archived` / `file.soft_deleted`, and refuses
    backward or illegal transitions (including quarantined-unverified -> archived) with
    `VALIDATION_FAILED`.
  - `fileRowSchema`: the full zod row shape validated on every read, so a schema drift fails in the
    service, not in a route.
- `verify.ts` - extended from 276 to **333 checks**: an in-memory `files` table (PostgREST-shaped
  `RestClient` that rejects unscoped queries and the unique key) driving record/read/list and the
  whole status walk, conflict and 404 paths, audit actions/payloads, key generation rules, and
  the purpose vocabulary; source scans over all ten files.
- `README.md` - the `records.ts` row and rules 8 (one object one row, tenant prefix in code and
  constraint alike).

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 333 checks, 2 adapter names (supabase + s3
  wired), 5 error codes, files sealed aes-256-gcm (master-v1), 7 purposes, signed urls 300s
  default / 900s max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  333 files, config, i18n 1608, logger, error, lint, shell, jobs 110, migrations 3261/111/85, kyc
  4142, auth 2543, build - all baselines unchanged).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/` 200, `/api/jobs/health` 200,
  `/api/onboarding/account-close` 422 without csrf, `/onboarding/account` 200 signed out; server
  killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## Next STEP

STEP 104 (line 1320): the KYC document storage category with tenant isolation paths - the KYC
purpose rules on top of this service (who may upload which document type, the
`<companyId>/kyc/...` path layout, magic-byte verification driving `markFileVerified` /
`quarantineFile`), and signed-URL downloads for the office screens on top of `createFileSignedUrl`.
