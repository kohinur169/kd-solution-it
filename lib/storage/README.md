// path: lib/storage/README.md

# Storage adapter port

The object storage layer of FEATURE_LIST section 21. Files never live on server-local disk: they
live in object storage through this adapter port, the active adapter is chosen by environment
configuration, downloads use short-lived signed URLs, and every file access is audit logged.

## The files

| File | What it owns |
| --- | --- |
| `types.ts` | The `StorageAdapter` interface - `upload`, `download`, `remove`, `createSignedUrl` - plus the closed `StorageError` vocabulary and the size, key, bucket and signed-URL bounds that mirror `migrations/0057_files.sql`. |
| `registry.ts` | The one place that knows which adapters exist. `activeAdapter()` reads `getServerConfig().storageProvider` (the environment's `STORAGE_PROVIDER`, `supabase` by default, `s3` for Amazon S3) and answers the adapter registered for it; until one is registered, operations answer `StorageError("unavailable")`. |
| `service.ts` | The only way feature code touches object storage: `uploadObject`, `downloadObject`, `deleteObject` and `createFileSignedUrl`. Each validates its input against the `0057` rules (no `..`, no empty segments, 50 MB ceiling, signed URLs 1-900 s, 300 s by default), runs the adapter and appends one audit entry - `file.uploaded`, `file.accessed` (operation `download` or `signed_url`) or `file.deleted`. A failing audit sink never fails the access. |
| `http.ts` | The one place that speaks HTTP to a provider: injectable `fetch`, timeout, `redirect: "error"`, every URL checked against the outbound policy of `lib/security/ssrf.ts`, bounded body reads, and the upstream status to `StorageError` mapping. |
| `supabase-adapter.ts` | The Supabase Storage adapter (the `STORAGE_PROVIDER=supabase` default). No SDK: it speaks the Storage REST API (`/storage/v1/object/...`, `/object/sign/...`) with the service role key as `apikey` + bearer, server only. |
| `s3-adapter.ts` | The Amazon S3 adapter (`STORAGE_PROVIDER=s3`). No SDK: it signs requests itself with AWS Signature Version 4 over `node:crypto`, pins the configured `S3_BUCKET` (any other bucket is refused before a request exists), and presigns downloads with `X-Amz-*` query parameters and `UNSIGNED-PAYLOAD`. |
| `adapters.ts` | The env wiring: `registerConfiguredAdapters(registry, env)` builds and registers both adapters; `registerDefaultStorageAdapters(registry)` does it from the validated `serverEnv()`. Asking for `s3` without the `S3_*` fields fails at wiring, not at the first upload. |
| `verify.ts` | The gate. Run it with `node lib/storage/verify.ts`. |

## Adapter selection by environment

`STORAGE_PROVIDER` (default `supabase`) is validated into `getServerConfig().storageProvider`, and
`activeAdapter(registry)` resolves the adapter registered under it - so the same build runs on
Netlify, Vercel or Amazon with only the environment changed. `S3_BUCKET`, `S3_REGION`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are required exactly when `STORAGE_PROVIDER=s3`.

## How the later steps build on it

- STEP 102 wraps the bytes in AES-256-GCM before `uploadObject` sees them.
- STEP 102 wraps the bytes in AES-256-GCM before `uploadObject` sees them.
- STEP 103 writes the `0057` file record (provider, hash, size, type, company, tenant-scoped key)
  around these operations.
- STEP 104 mints signed URLs for the office screens; STEP 105 exposes upload and download.

## The rules

1. Feature code never picks an adapter by name and never imports a provider SDK; it calls the
   service functions with `activeAdapter(registry)`.
2. A bucket or key is validated before it reaches a provider: the same rules the database
   enforces, so a malformed address is refused here, not discovered at the provider.
3. Signed URLs are short-lived: five minutes by default, fifteen at most, and a request outside
   the bounds is refused rather than clamped.
4. Every operation appends exactly one audit entry through `lib/auth/audit.ts`.
5. Stored files never touch server-local disk: no filesystem import in any runtime file, and the gate scans for it.
6. Credentials and signatures never leave the headers of a signed request, never enter a URL beyond the presigned `X-Amz-*` parameters, and never appear in a log line or an error message.
