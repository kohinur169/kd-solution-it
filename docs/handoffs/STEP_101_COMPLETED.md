// path: docs/handoffs/STEP_101_COMPLETED.md
# STEP 101 - Supabase Storage and Amazon S3 storage adapters with adapter selection by environment configuration for Netlify, Vercel and Amazon hosting: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 101 code are in one commit, the
one whose message is "STEP 101: Supabase Storage and Amazon S3 storage adapters with adapter
selection by environment configuration for Netlify, Vercel and Amazon hosting" (`git log -1` on
the branch shows its hash). Previous handoff: `docs/handoffs/STEP_100_COMPLETED.md`.

## STEP

- **Number and title:** STEP 101 - Supabase Storage and Amazon S3 storage adapters with adapter
  selection by environment configuration for Netlify, Vercel and Amazon hosting
  (`docs/final/STEP_PLAN_250.md`, line 1284, "File Storage Layer" block).
- **Category:** File Storage Layer, STEPs 100-105. Second STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP added files only inside `lib/storage/` plus this handoff: `http.ts`, `supabase-adapter.ts`,
  `s3-adapter.ts`, `adapters.ts`, and edits to `verify.ts` and `README.md`. Read-only imports from
  `lib/security/ssrf.ts`, `lib/env/server.ts`, `config/server.ts` (via `registry.ts`).
- **Feature list:** section 21 "File Storage" lines 223-224 - "Two adapters are built in: Supabase
  Storage and Amazon S3. The active adapter is selected by environment configuration, so the same
  build runs with the application hosted on Netlify, Vercel or Amazon without rewriting the core.
  Server-local disk is never used for stored files."
- **Depends on:** STEP 100 (`lib/storage/` port, registry, audited service), STEP 004
  (`lib/env/manifest.ts`: `STORAGE_PROVIDER` enum default `supabase`; `S3_BUCKET`/`S3_REGION`/
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` required when `STORAGE_PROVIDER=s3`;
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` always required), `config/server.ts`
  (`getServerConfig().storageProvider`), STEP 058 (`lib/security/ssrf.ts` outbound policy).
  No new env vars, no migration, no routes, no UI - the adapters are wired into the STEP 100
  registry and nothing calls them yet (STEP 103+ does).

## What was built

All inside `lib/storage/`. The platform has no Supabase or AWS SDK in its dependency tree and
`package.json` is integrator-owned, so both adapters speak their provider's HTTP API directly with
an injectable `fetch` - the same pattern as `lib/auth/rest.ts` + `lib/auth/http.ts`.

- `http.ts` - the shared transport: `StorageFetch` (injectable fetch), `storageFetch` (outbound
  policy check via `checkOutboundUrl` before any socket, `redirect: "error"`, 30 s timeout,
  network failure -> `provider_error`), `storageErrorForStatus` (404 -> `not_found`, 409 ->
  `conflict`, 400/422 -> `invalid_input`, else `provider_error`; messages never contain a URL,
  header or body), `readBoundedBytes` (50 MB ceiling on downloads, declared and actual length),
  `readErrorCode` (bounded XML `<Code>` read for S3), path encoders.
- `supabase-adapter.ts` - `createSupabaseStorageAdapter(env, deps)`: `POST/GET/DELETE
  {SUPABASE_URL}/storage/v1/object/{bucket}/{key}` and `POST .../object/sign/{bucket}/{key}` with
  `{"expiresIn": ttl}`, service role key as `apikey` + `Authorization: Bearer`, per-call bucket
  (the `0057` record stores it), signed answer accepted only when it is a `/object/sign/...` path
  resolved against the project URL (never an absolute URL), `expiresAt` computed from the
  injectable clock.
- `s3-adapter.ts` - `createS3StorageAdapter(env, deps)`: virtual-hosted
  `https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{key}`, AWS Signature Version 4 implemented over
  `node:crypto` (`awsUriEncode` RFC 3986 strict, `amzDates`, `s3SigningKey`, canonical
  request/string-to-sign), PUT/GET/DELETE with `x-amz-content-sha256` payload hash and signed
  `Authorization` header, `NoSuchKey`/`NotFound`/`NoSuchBucket` XML codes mapped to `not_found`,
  downloads presigned as `X-Amz-*` query URLs with `UNSIGNED-PAYLOAD` (no request sent, secret
  never in the URL), and the configured-bucket pin: any other bucket is `invalid_input` before a
  request is built.
- `adapters.ts` - the environment selection of the title: `registerConfiguredAdapters(registry,
  env, deps)` builds and registers both adapters (Supabase always, S3 when the `S3_*` fields are
  present; `STORAGE_PROVIDER=s3` without them, or partial `S3_*` fields, throws at wiring), and
  `registerDefaultStorageAdapters(registry)` does it from the validated `serverEnv()`.
  `activeAdapter(registry)` from STEP 100 then resolves `getServerConfig().storageProvider`, so a
  deployment changes only its environment.
- `verify.ts` - extended from 116 to **212 checks**: fake-transport runs of both adapters (exact
  URLs, methods, `apikey`/bearer headers, SigV4 authorization shape `Credential=.../date/region/
  s3/aws4_request, SignedHeaders=..., Signature=<64 hex>`, deterministic re-signing at a fixed
  clock, sha256 payload hash, 409/404/NoSuchKey mappings, presigned URL parameter assertions,
  bucket pinning, non-https endpoint refused with `unavailable` and zero requests sent, absolute
  signed-URL answer refused), plus the registration matrix (both adapters wired, supabase-only
  without S3 fields, `s3` without fields and partial fields both failing at wiring), and source
  scans over all nine files.
- `README.md` - the adapter table, the env selection paragraph, and the credential-handling rule.

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 212 checks, 2 adapter names (supabase + s3
  wired), 5 error codes, signed urls 300s default / 900s max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  331 files, config, i18n 1608, logger, error, lint, shell, jobs 110, migrations 3261/111/85, kyc
  4142, auth 2543, build - all baselines unchanged).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/` 200, `/api/jobs/health` 200,
  account routes 422 without csrf, `/onboarding/account` and `/onboarding/status` 200 signed out;
  server killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## Next STEP

STEP 102 (line 1296): AES-256-GCM encryption of the bytes before upload, using the
`ENCRYPTION_MASTER_KEY` of the environment and the encryption quartet columns `0057` already has
(`encryption_algorithm`, `encryption_key_version`, `ciphertext_iv`, `ciphertext_tag`).
