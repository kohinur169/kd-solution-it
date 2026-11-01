// path: docs/planning/STEP_031_SUBSTEP_BREAKDOWN.md
# STEP 031 - Sub-Step Breakdown

This document is sub-step 031.1. It reads the plan, the feature list and the STEP 030 handoff,
measures the schema, fixes the design of the one table this STEP owns, and then stops for the
owner's permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_031_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 031 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for files and storage records table".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 028 created `kyc_documents`, which keeps its own storage key, hash, type and
  size; STEP 023 and STEP 027 gave the ciphertext quartet its shape in `provider_keys` and
  `payout_bank_accounts`; STEP 017 the append-only audit chain every access writes to; STEP 001
  the tenant root; STEP 003 the user. STEP 100-105 own `lib/storage/`, STEP 035 the permissive
  policies, STEP 244-250 the backup and retention operations, and STEP 147 onwards the adapters
  that call a provider.

### Feature list lines that fix the shape
- Section 21: "Files live in object storage through the storage adapter layer. Two adapters are
  built in: Supabase Storage and Amazon S3."
- Section 21: "Every file is AES-256-GCM encrypted before upload."
- Section 21: "Every file record stores storage_provider, hash, size, type and company."
- Section 21: "File type and magic byte verification and file size limits apply."
- Section 21: "Downloads use short-lived signed URLs. Every file access is audit logged."
- Section 21: "KYC documents, logos, invoice PDFs, dispute documents and support attachments can
  be uploaded."
- Section 30: object storage is "configured by environment variables with two built-in adapters
  ... for encrypted file storage with tenant separated paths".
- Section 13 keeps records for seven years, which is why nothing here is physically removed.
- MASTER_PROMPT rules 7 and 8: `id` UUID v7, `company_id`, `created_at`, `updated_at`,
  `deleted_at`, `version`, row level security and a default-deny policy on every table.

### What exists today (measured before writing this document)
- 56 migrations, 56 tables, 56 policies, 104 triggers, 53 functions and 235 indexes in
  `public`, and the gate reports 1739 checks. STEP 030 closed with commit `fae0fb8`, and the
  audit of STEP 001-030 with `6a0e4eb`.
- `kyc_documents` (STEP 028) already stores `storage_key`, `content_sha256`, `content_type` and
  `byte_size` itself, bounded at 52428800 bytes by `kyc_documents_size_check`, and
  `kyc_documents_guard_state` freezes them. Migrations are append only, so this STEP neither
  repeats nor rewrites that row.
- `provider_keys` and `payout_bank_accounts` already fix the ciphertext quartet: `*_iv` of 12 to
  64 characters, `*_tag` of 16 to 64 and `encryption_key_version` of 1 to 999.
- The environment contract already names `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`,
  `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `config/app.ts` has ten sections (platform,
  money, lists, security, payouts, reconciliation, disputes, billing, caching, jobs) and no
  storage section, so no size limit and no link lifetime is a database default here.
- `users` has no `unique (id, company_id)` key, so a composite tenant foreign key on the
  uploader is impossible without editing STEP 003. The precedent for that case is
  `holds_guard_owner`, which checks the owner inside the trigger instead.
- `audit_logs` (STEP 017) is the append-only hash chain every file access writes to, so this
  STEP adds no second access log: a second log would be a second truth.

## 2. Decisions This STEP Makes

1. **One table records one stored object.** `public.files` is the row behind bytes that live in
   object storage: the provider, the bucket, the key, the hash, the size, the type and the
   merchant. The title's "files and storage records" is this row, not two tables, which the
   owner confirmed before this document was written.
2. **The KYC document keeps its own row.** `kyc_documents` holds key, hash, type and size and
   freezes them already; the five upload kinds section 21 names become the closed `purpose`
   vocabulary here, and a future STEP that attaches a file to an invoice, a dispute or a ticket
   adds its own column rather than a polymorphic pair.
3. **A key, never a URL.** A signed URL expires and a stored one would rot, so the row keeps the
   three facts an adapter needs to sign a fresh one: `storage_provider`, `storage_bucket` and
   `storage_key`.
4. **Tenant separation is a check, not a promise.** `files_tenant_path_check` requires
   `storage_key like company_id::text || '/%'`, so even a service bug cannot point one
   merchant's row at another merchant's prefix.
5. **The ciphertext quartet mirrors the key tables.** `encryption_algorithm` is fixed to
   `aes-256-gcm` beside `encryption_key_version`, `ciphertext_iv` and `ciphertext_tag`; the
   ciphertext itself never reaches the database, because section 21 encrypts before upload.
6. **The hash is of the plaintext.** `content_sha256` is the SHA-256 of the bytes before
   encryption, so a restore can prove that the object the bucket returned is the object the row
   describes. The guard freezes it with the rest of the identity.
7. **The size ceiling matches the document table.** `byte_size` is bounded by the same 52428800
   the KYC documents use. A per purpose limit and the signed URL lifetime are settings for the
   adapter STEPs of 100-105 and are not columns here.
8. **Verification is a state with evidence.** `magic_byte_verified` and `verified_at` arrive
   together, `status` cannot say `ready` or `archived` without them, and a `quarantined` row
   must carry its reason. The reason survives the move to `archived`, because it is the history
   of why the file never reached a person. `archived` is the end of an active file's life, not a
   delete.
9. **The guard freezes the bytes and walks the status forward.** Company, uploader, purpose,
   provider, bucket, key, content type, size, hash, algorithm, key version, iv and tag never
   change after insert; `magic_byte_verified` only turns on; the status walks `pending` to
   `ready` or `quarantined`, `ready` to `quarantined` or `archived`, and `quarantined` to
   `archived`. The same trigger checks on insert that the uploader belongs to the merchant,
   which is the `holds_guard_owner` pattern `users` forces on this table.
10. **The soft delete marker is set once and never cleared.** Section 13 keeps records for seven
    years, so a removed file is a row with `deleted_at`; the retention job of STEP 244-250
    removes the object and the row. The unique key index is whole rather than partial, so a
    soft-deleted row still owns its storage key and a re-upload cannot create a second record of
    one object.

## 3. The Schema This Produces

### `0057_files.sql`
`id`, `company_id`, `uploaded_by`, `purpose`, `storage_provider`, `storage_bucket`,
`storage_key`, `content_type`, `byte_size`, `content_sha256`, `encryption_algorithm`,
`encryption_key_version`, `ciphertext_iv`, `ciphertext_tag`, `magic_byte_verified`,
`verified_at`, `status`, `quarantined_reason` and the four audit columns: 22 columns.

Checks: the primary key; two foreign keys (`companies`, and the uploader in `users`); the
purpose vocabulary of the five kinds section 21 names; the provider vocabulary `supabase` and
`s3`; the bucket shape, the key shape and the tenant prefix; the content type, the 64 hex hash
and the 50 MB ceiling; the fixed algorithm with the iv, tag and key version bounds; the status
vocabulary; the verified pair with its instant; the quarantine reason, required by that state
and kept when the file is archived; the instant order and the three row metadata checks.

Guard: `files_guard_state` runs on insert and on update. On insert it refuses an uploader of
another merchant; on update it freezes the identity of the bytes and walks the status forward.

Indexes: `files_storage_key` (unique over provider, bucket and key, whole rather than partial),
`files_company_page_idx` (the merchant library, newest first), `files_purpose_idx` (one purpose
of one merchant, newest first) and `files_verification_idx` (the sweep that finishes a
verification or archives a quarantine): four plus the primary key.

The table is default-deny with its own policy and carries `set_row_metadata`.

## 4. The Sub-Steps

### 031.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list, the master prompt and the STEP 030 handoff; measured the
schema; fixed the design above. No file outside this document is touched. It stops for
permission.

### 031.2 - `0057_files.sql` and `0057_files.down.sql`
The table, its two foreign keys, checks, guard, four indexes, comments on every table and
column, row level security and the policy, then a forward apply of `0001` to `0057` and a
rollback that leaves the schema exactly where STEP 030 left it.

### 031.3 - The proof, the docs, the verification and the commit
The behaviour proof of every rule (the purpose and provider vocabularies, the tenant prefix, the
key and hash shapes, the size ceiling, the ciphertext bounds, the verified pair, the quarantine
reason, the owner check, the frozen identity, the status walk, the soft delete, RLS and both
rollbacks), the gate and behaviour probes, the two README patches, `npm run verify`, the handoff
file and the single commit "STEP 031: Migration for files and storage records table", with its
push.

## 5. Files This STEP Owns
- `migrations/0057_files.sql` and `migrations/0057_files.down.sql`
- `migrations/README.md` (one inventory row and one rule)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_031_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_031_COMPLETED.md`
- Not owned and not touched: `0001` to `0056`, `lib/storage/` (STEP 100-105), the upload and
  signed URL routes, `config/` (it has no storage section), `kyc_documents`, the audit chain of
  017, the permissive RLS policies of 035, the adapters of 147 onwards and every code STEP.

## 6. What This STEP Deliberately Leaves Out
- The adapters themselves: STEP 100-105 read this row and call Supabase Storage or Amazon S3.
- Signed URLs, the upload route and the download route: a service STEP signs them; the row
  carries the three facts a signature needs.
- Magic byte reading: the adapter reads the bytes, and this table records that it happened,
  when, and whether the file passed.
- Per purpose size limits and link lifetimes: settings in `config/`, owned by a later STEP.
- The audit entry of an access: STEP 017's hash chain exists already and the service writes to
  it.
- Versioning of a file's bytes, which section 31 asks for: an operations STEP of 244-250 can add
  a supersede column in its own migration, and nothing here blocks it.
- Any change to `kyc_documents`: migrations are append only.

## 7. Corrections From The 031.2 Proof

The forward apply, the fifty five behaviour probes and the rollback found one design error and
two stale expectations, and all are settled:

1. **The quarantine rule forbade archiving.** The first version made the reason present
   exactly while the status was `quarantined`, so moving a quarantined file to `archived` failed
   the check although the guard allows the move. The rule is now two implications: a
   `quarantined` row must carry its reason, and a reason is legal only on a `quarantined` or an
   `archived` row, so the reason is history that an archive keeps.
2. **Two counted numbers were predicted one low.** The schema holds 240 indexes after this
   migration, not 239, and the comment count includes the table comment: 22 column comments
   plus the table comment. Both are measured, not guessed, in the handoff.
3. **The probe used a uuid without its hyphens.** `files_tenant_path_check` compares the key
   with the text form of the company id, so a key built from `uuid.hex` was refused and the
   constraint was right. The probe now uses the hyphenated form.
