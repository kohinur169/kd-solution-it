// path: docs/handoffs/STEP_100_COMPLETED.md
# STEP 100 - Storage adapter interface with upload, download, delete, signed URL and file access audit logging: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 100 code are in one commit, the
one whose message is "STEP 100: Storage adapter interface with upload, download, delete, signed
URL and file access audit logging" (`git log -1` on the branch shows its hash). Previous handoff:
`docs/handoffs/STEP_099_COMPLETED.md`.

## STEP

- **Number and title:** STEP 100 - Storage adapter interface with upload, download, delete, signed
  URL and file access audit logging (`docs/final/STEP_PLAN_250.md`, line 1272, "File Storage Layer"
  block).
- **Category:** File Storage Layer, STEPs 100-105. First STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP created exactly that directory and nothing else outside it plus this handoff. Read-only imports
  from `config/server.ts`, `lib/auth/audit.ts`, `lib/utils/freeze.ts` (dropped again - see below) and
  `lib/env`.
- **Feature list:** section 21 "File Storage", lines 222-230 - the two adapter lines and the
  environment selection belong to STEP 101, AES-256-GCM to STEP 102, the file record to STEP 103;
  this STEP owns "Downloads use short-lived signed URLs. Every file access is audit logged." and the
  adapter layer itself, including "Server-local disk is never used for stored files."
- **Depends on:** STEP 012+ migrations in particular `0057_files.sql` (the `files` table whose bucket,
  key, size and content-type checks this port mirrors in code), `0058_file_purposes.sql`, the
  `STORAGE_PROVIDER` / `S3_*` entries of `lib/env/manifest.ts` and `.env.example` lines 56-80, and
  `config/server.ts` (`getServerConfig().storageProvider`, server-only, lazy). No new env vars, no
  migration, no routes and no UI in this STEP.

## What was built

`lib/storage/` - the object storage port:

- `types.ts` - the `StorageAdapter` interface with exactly the five operations of the title:
  `upload`, `download`, `remove`, `createSignedUrl`, each on a bucket + key reference; the closed
  `StorageError` vocabulary (`invalid_input`, `not_found`, `unavailable`, `conflict`,
  `provider_error`) with `isStorageError`; and the bounds copied from `0057`: `MAX_OBJECT_BYTES`
  52428800 (50 MB), key pattern `^[A-Za-z0-9][A-Za-z0-9._/-]*$` length 3..512, bucket pattern
  `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` length 3..63, content type pattern, and the signed URL
  lifetimes 1..900 s with 300 s default (section 21 says short-lived).
- `registry.ts` - `StorageAdapterRegistry` (register/get/has/names/size, duplicate registration throws
  `StorageAdapterAlreadyRegisteredError`, unknown name is `invalid_input`), `adapterFor(registry,
  provider)` answering `StorageError("unavailable")` when no adapter serves the provider, and
  `activeAdapter(registry)` reading `getServerConfig().storageProvider`. Adapters are NOT frozen on
  registration: a real adapter holds a live provider client, and `deepFreeze` would freeze it (the
  job registry freezes definitions because they are pure; adapters are not).
- `service.ts` - the only way feature code touches storage: `uploadObject`, `downloadObject`,
  `deleteObject`, `createFileSignedUrl`. Each validates the ref (bucket rule, key rule plus the
  `..` / `//` / trailing-slash traversal refusals, size 1..50 MB, content-type pattern, TTL bounds -
  out-of-range refused, not clamped), runs the adapter, then appends exactly one audit entry through
  `lib/auth/audit.ts`: `file.uploaded`, `file.accessed` (payload operation `download` or
  `signed_url`) or `file.deleted`, entity type `file`, entity id the `0057` row when known, actor and
  company from the `FileAccessContext`, payload carrying bucket, key, purpose, provider, size,
  content type, expiry. A failing audit sink never fails the access (same tolerance as the KYC
  services). Provider errors propagate typed.
- `verify.ts` - the gate, run directly with `node lib/storage/verify.ts` (package.json is
  integrator-owned, so no `check:storage` script was added; `npm run -s verify` still passes because
  the structure gate only requires the `// path:` first line and no forbidden markers under `lib/`).
  116 checks: vocabulary and bounds; registry duplicate/unknown/unavailable; bucket/key/TTL
  validation refusing traversal and out-of-bounds values before the adapter is called; all four
  operations against a fake adapter with exact audit action/entity/payload assertions; typed
  `not_found` and `provider_error` propagation; upload still succeeding with the audit sink down;
  source scans (ASCII, path comments, no filesystem import and no console write in the runtime
  files - the gate builds its console marker as a regex so the forbidden literal never appears).
- `README.md` - the port's contract and how STEPs 101-105 build on it.

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 116 checks, 2 adapter names, 5 error codes,
  signed urls 300s default / 900s max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure,
  kyc 4142, auth 2543, i18n 1608, migrations 3261/111/85, build all green, unchanged baselines).
- Smoke on PORT=3107 with `.env.local` copied from `.env.example`: `/` 200, `/api/jobs/health` 200,
  the five STEP 099 account routes 422 without a csrf token, `/onboarding/account`,
  `/onboarding/account-review`, `/onboarding/status` 200 signed out; server killed, `.env.local`
  removed.
- ASCII scan clean on every new file.

## Next STEP

STEP 101 (line 1284): the Supabase Storage and Amazon S3 adapters, registered into this registry,
with `STORAGE_PROVIDER` selecting the active one for Netlify, Vercel and Amazon hosting. Then 102
(AES-256-GCM before upload), 103 (the `0057` file record around these operations), 104 (signed URL
downloads for the office), 105 (upload/download endpoints).
