// path: docs/handoffs/STEP_102_COMPLETED.md
# STEP 102 - AES-256-GCM file encryption before upload: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 102 code are in one commit, the
one whose message is "STEP 102: AES-256-GCM file encryption before upload" (`git log -1` on the
branch shows its hash). Previous handoff: `docs/handoffs/STEP_101_COMPLETED.md`.

## STEP

- **Number and title:** STEP 102 - AES-256-GCM file encryption before upload
  (`docs/final/STEP_PLAN_250.md`, line 1296, "File Storage Layer" block).
- **Category:** File Storage Layer, STEPs 100-105. Third STEP of the block.
- **Owned paths (File Ownership Rules):** "Storage STEPs 100-105 own `lib/storage/`" (line 52). This
  STEP added `lib/storage/encryption.ts` and edited `lib/storage/service.ts`, `verify.ts`,
  `README.md`, plus this handoff. Read-only imports from `lib/security/encryption.ts` (the cipher
  module of the earlier security STEPs), `lib/security/upload.ts` (`UPLOAD_PURPOSES`),
  `lib/errors/app-error.ts`, `lib/env/server.ts`.
- **Feature list:** section 21 "File Storage", line 225 - "Every file is AES-256-GCM encrypted
  before upload."
- **Depends on:** STEP 100 (port, registry, audited service), STEP 101 (adapters), the `0057`
  encryption quartet (`encryption_algorithm = 'aes-256-gcm'`, `encryption_key_version` 1..999,
  `ciphertext_iv` 12..64 chars of base64, `ciphertext_tag` 16..64 chars, `content_sha256` = SHA-256
  of the *plaintext*, `byte_size` = plaintext size), `ENCRYPTION_MASTER_KEY` (base64 of 32 bytes,
  always required, secret) in `lib/env/manifest.ts` line 122, and the `KDF1` envelope module
  `lib/security/encryption.ts` (`encryptFile`/`decryptFile`: header + one 64 KiB AEAD record per
  chunk, per-chunk nonce carrying the position, AAD `kd-aad-v1|file|<scope>`).
  No new env vars, no migration, no routes, no UI.

## What was built

- `lib/storage/encryption.ts` - the wiring of section 21's encryption line:
  - `fileEncryptionKeyring(env)`: the master key as primary under key id `master-v1`; the secret is
    validated as base64 of exactly 32 bytes at construction, so a malformed `ENCRYPTION_MASTER_KEY`
    fails at wiring, not at the first upload. Rotation later = add the new key as primary, keep
    `master-v1` in `previous`, bump the version.
  - `fileEncryptionScope({ companyId, purpose })` -> `file:<companyId>:<purpose>`: the AAD scope.
    A ciphertext sealed for one tenant's `kyc_document` fails the tag when opened as another
    tenant's or another purpose's file - copying an object between rows fails loudly. Company id
    (UUID) and purpose (the five `UPLOAD_PURPOSES`) are validated before they reach the tag.
  - `sealFile(keyring, plaintext, scope)` -> `SealedFile`: refuses empty/over-50 MB plaintext,
    delegates to `encryptFile`, then reads the quartet back out of the produced envelope:
    `algorithm` "aes-256-gcm", `keyVersion` derived from the envelope's key id (`keyVersionOfKeyId`,
    refused outside 1..999), `iv` = base64 of the 12-byte base IV (16 chars, inside `0057`'s
    12..64), `tag` = base64 of the first chunk's 16-byte tag (24 chars, inside 16..64), plus
    `plaintextSha256` (hex, `content_sha256`), `plaintextBytes` (`byte_size`) and
    `ciphertextBytes` (envelope length).
  - `openSealedFile(keyring, envelope, scope)`: refuses non-envelopes before a key lookup and
    returns the plaintext only after every chunk authenticates under the scope.
  - `createFileEncryption(env)` / `createDefaultFileEncryption()` (reads `serverEnv()`): the
    `StorageFileEncryption` dependency the service takes.
- `lib/storage/service.ts` - the two encrypted operations next to the plain ones:
  - `uploadEncryptedObject(adapter, input, access, deps & { encryption })`: seals the bytes, uploads
    only the envelope as `application/octet-stream`, audits `file.uploaded` with the quartet, the
    plaintext hash and both sizes in the payload (never the bytes), and answers
    `{ stored, sealed }` so STEP 103 can write the `0057` row from `sealed`.
  - `downloadEncryptedObject(...)`: downloads the object, refuses it with `provider_error` when it
    is not a well formed envelope or its plaintext size exceeds the ceiling, decrypts under the
    same tenant+purpose, audits `file.accessed` (operation `download`, plaintext size, encrypted
    flag), returns the plaintext.
  - Both refuse `invalid_input` when the access context lacks the company id or a known purpose -
    the scope cannot be built without them.
- `verify.ts` - extended from 212 to **276 checks**: keyring/scope/key-version rules; seal answers
  (KDF1 magic, envelope recognised, 12-byte IV and 16-byte tag in base64, plaintext SHA-256,
  sizes); round trips including a two-chunk file; a second seal differing in the IV; cross-tenant
  and cross-purpose opens failing `authentication_failed`; tampered/truncated/non-envelope inputs
  refused (`authentication_failed` / `envelope_invalid`, via `AppError` cause reasons); empty and
  over-ceiling plaintext refused; and the encrypted service operations against the fake adapter
  (adapter receives the envelope as octet-stream, audit payload carries the quartet, download
  returns the plaintext, non-envelope object -> `provider_error`, missing tenant -> `invalid_input`).
- `README.md` - the `encryption.ts` row, the encrypted operations, and rule 7 (only the envelope
  reaches a provider; the key lives only in the environment; the database holds quartet + hash,
  never ciphertext).

## Verification

- `node lib/storage/verify.ts` -> "storage gate passed: 276 checks, 2 adapter names (supabase + s3
  wired), 5 error codes, files sealed aes-256-gcm (master-v1), signed urls 300s default / 900s
  max", exit 0.
- `npm run -s typecheck` exit 0; `npm run -s lint` exit 0; `npm run -s verify` exit 0 (structure
  332 files, config, i18n 1608, logger, error, lint, shell, jobs 110, migrations 3261/111/85, kyc
  4142, auth 2543, build - all baselines unchanged).
- Smoke on PORT=3107 with `.env.local` from `.env.example`: `/` 200, `/api/jobs/health` 200,
  `/api/onboarding/account-close` 422 without csrf, `/onboarding/account` 200 signed out; server
  killed, `.env.local` removed.
- ASCII and forbidden-marker scans clean on every touched file.

## Next STEP

STEP 103 (line 1308): the file record service - storing provider, bucket, key, hash, size, type
and company in the `0057` `files` row around `uploadEncryptedObject`'s `SealedFile`, with the
tenant path rule (`storage_key` starts with `company_id/`), magic-byte verification status, and
status walk `pending -> ready/quarantined -> archived`.
