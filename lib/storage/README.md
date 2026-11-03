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
| `verify.ts` | The gate. Run it with `node lib/storage/verify.ts`. |

## How the later steps build on it

- STEP 101 registers the two adapters - Supabase Storage and Amazon S3 - so `activeAdapter()`
  resolves the environment's provider. Adapters are server only and never touch local disk.
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
