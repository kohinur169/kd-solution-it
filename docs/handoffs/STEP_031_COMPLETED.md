// path: docs/handoffs/STEP_031_COMPLETED.md
# STEP 031 Completed - Handoff

## STEP
- Number and title: STEP 031 - Migration for files and storage records table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 028 (the
  `kyc_documents` row that already keeps its own key, hash, type and size), STEP 023 and STEP
  027 (the ciphertext quartet shape in `provider_keys` and `payout_bank_accounts`), STEP 017
  (the append-only audit chain every access writes to), STEP 001 (the merchant every row
  belongs to) and STEP 003 (the uploader). STEP 100-105 own `lib/storage/`, STEP 035 the
  permissive policies, STEP 244-250 the retention and backup operations, and STEP 147 onwards
  the adapters. The owner split this STEP into three sub-steps with an approval between each,
  and the plan is `docs/planning/STEP_031_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0057_files.sql and 0057_files.down.sql - the stored object record with its
    provider, bucket, tenant prefixed key, plaintext hash, size, type, AES-256-GCM quartet, the
    magic byte verdict, its four states and the guard that freezes the bytes.
  - docs/planning/STEP_031_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_031_COMPLETED.md.
- Modified:
  - migrations/README.md - one inventory row for `0057`, one new rule (a file is a key and a
    hash, never a URL), and the numbering rule moved from 44 to 45.
  - README.md - the database section describes the file records, directly above the
    `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: migrations `0001` to
  `0056`, `lib/storage/` (STEP 100-105), the upload and signed URL routes, `config/` (it has no
  storage section), `kyc_documents`, the audit chain of 017, the permissive RLS policies of 035,
  the adapters of 147 onwards and every code STEP. `package.json` and `migrations/verify.ts` are
  untouched; the gate needed no change for one table.

## Database
- Migrations added (file names): `0057_files`, with its `.down.sql`. It creates one table with
  22 columns, 25 constraints, five indexes (the primary key and four), two triggers, one guard
  function and 23 comments (the table and its 22 columns). The schema now holds 57 tables, 57
  policies, 106 triggers, 54 functions and 240 indexes in `public`.
- Shape of the table: `files` 22 columns, 25 constraints, five indexes, two triggers, 23
  comments; the table is default-deny with its own `files_default_deny` policy.
- What the row is: the provider, the bucket and the key rather than a URL, beside the plaintext
  SHA-256, the size, the type, the purpose and the merchant. `purpose` is the closed list of the
  five upload kinds section 21 names, and no file bytes, no base64 blob and no signed link is a
  column.
- Tenant separation is a check. `files_tenant_path_check` requires `storage_key like
  company_id::text || '/%'`, so a row cannot point at another merchant's prefix even if the
  service is wrong, and `files_key_check` refuses a key with a parent segment that would climb
  out of it.
- The ciphertext quartet mirrors the key tables: `encryption_algorithm` fixed to `aes-256-gcm`,
  `encryption_key_version` of 1 to 999, `ciphertext_iv` of 12 to 64 characters and
  `ciphertext_tag` of 16 to 64. The ciphertext itself never reaches the database.
- Verification is a state with evidence. `pending` may carry no verdict, `ready` and `archived`
  require `magic_byte_verified` with `verified_at`, and `quarantined` requires its reason; the
  reason stays when the file is later archived, because it is the history of why the file never
  reached a person.
- `files_guard_state` freezes merchant, uploader, purpose, provider, bucket, key, type, size,
  hash and the quartet, refuses a verdict that is taken back, walks the status forward only, and
  refuses a rewrite of a quarantine reason or of a deleted row. On insert it refuses an uploader
  of another merchant, which `users` forces because it has no `(id, company_id)` key.
- One storage key is one row for ever: `files_storage_key` is a whole unique index, so a
  soft-deleted row still owns its key and a re-upload cannot fork the record of one object.
- The soft delete marker is set once and never cleared, because section 13 keeps records for
  seven years; the retention job of STEP 244-250 removes the object and the row.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The rollback
  returned the schema to 56 tables, 56 policies, 104 triggers and 53 functions, dropped the
  guard function and the table, and the forward file applied again to 57 tables, 57 policies,
  106 triggers and 54 functions. The rollback ran on a database with every migration applied and
  the STEP's own probe rows in it, not on a hand loaded fixture.

## Environment
- Environment variables added to .env.example: none. The adapter STEPs of 100-105 read
  `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`,
  which STEP 004 already declared.
- Secrets handled (names only, never values): none. The proofs wrote synthetic keys, hashes and
  ciphertext placeholders in throwaway local databases, and no real object, credential or key
  material was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
One proof script ran 54 checks against the local PostgreSQL 16.2, four gate probes tested the
static gate and a detach probe tested the guard; every check passed and the script ended with
`PROOF COMPLETE: 0 FAIL`.

1. **Forward apply.** `0001` to `0057` applied in order and produced 57 tables, 57 policies, 106
   triggers, 54 functions and 240 indexes, and `files` matched its measured shape exactly: 22
   columns, 25 constraints, five indexes, two triggers and 23 comments.
2. **The vocabularies hold.** A purpose outside the five kinds was refused by
   `files_purpose_check` and a provider outside the two adapters by `files_provider_check`.
3. **The bucket and the key have shapes.** An upper case bucket and a bucket of two characters
   were refused by `files_bucket_check`; a key with a space by `files_key_check`.
4. **Tenant separation is enforced.** A key under another merchant's id was refused by
   `files_tenant_path_check`, and a key that climbed out with `/../` was refused by
   `files_key_check`.
5. **The file facts are bounded.** A content type without a slash, a file of zero bytes, a file
   of 52428801 bytes, a hash that was not 64 lower case hex, a cipher other than AES-256-GCM, a
   key version of zero, an iv of three characters and a tag of eight were each refused by the
   check that owns them.
6. **Verification is evidence.** A status outside the four was refused by `files_status_check`,
   a `pending` row that claimed a verdict by `files_pending_check`, a `ready` row without one by
   `files_verified_check`, and a `ready` row carrying a quarantine reason by
   `files_quarantine_scope_check`.
7. **A quarantine needs its reason.** A quarantined row without a reason was refused by
   `files_quarantine_required_check` and a reason of 300 characters by
   `files_quarantine_reason_check`.
8. **The uploader belongs to the merchant.** An uploader of another merchant was refused with
   "a file uploader belongs to the merchant of the file".
9. **The life moves forward.** A `pending` file became `ready` with its verdict at version 2, a
   verdict taken back was refused with "a magic byte verdict is recorded once and never
   cleared", and a moved verification instant with "a file verification instant is recorded
   once".
10. **The bytes are frozen.** Rewriting the key, the hash, the size or the purpose was refused
    with "a file keeps its merchant, its key and its bytes"; the four gone together are the
    identity, not a preference.
11. **The status walks one way.** A backward move was refused with "a file status walks
    forward from pending to ready, quarantine or archive"; a `ready` file was quarantined with
    its reason at version 3; the reason could not be rewritten ("a quarantine reason is recorded
    once and never rewritten"); the row was archived at version 4 and kept its reason; an
    archived row moving again was refused, and so was an unverified quarantine that tried to
    archive.
12. **One object, one row.** The same provider, bucket and key was refused a second row by
    `files_storage_key`; a file was soft deleted once at version 2; a deleted file was refused
    any rewrite with "a deleted file is history"; and the soft deleted key could not be re-used.
13. **Every index answers its screen.** With sequential scans disabled the planner chose
    `files_company_page_idx` for the merchant library, `files_purpose_idx` for one purpose of
    one merchant, and `files_verification_idx` for the verification sweep.
14. **Row level security.** A plain role with table grants saw zero rows and could not insert
    ("new row violates row-level security policy for table \"files\"").
15. **The guard is load bearing.** With `files_guard_state` dropped the storage key of a row was
    rewritten; with the trigger restored the same write was refused again with "a file keeps its
    merchant, its key and its bytes".
16. **Rollback and re-apply.** The rollback returned 56 tables, 56 policies, 104 triggers and 53
    functions, dropped the table and the guard function, and the forward file applied again to
    57 tables, 57 policies, 106 triggers and 54 functions.
17. **The static gate is awake.** Four temporary edits were offered to it and all four were
    caught: a removed `enable row level security`, a removed `commit;`, a policy reading
    `using (true)`, and a removed `deleted_at` column.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1770 checks, 57 migrations, 57 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; error
  gate 196 checks; lint gate 77 checks; shell gate 98 checks; jobs gate 110 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully and prerendered the routes.
- Proof scripts: `/tmp/proof_0312.py` (54 checks, `PROOF COMPLETE: 0 FAIL`) and the detach probe
  in the same database (three writes, the middle one allowed while the guard was dropped).

## Errors Found And Corrected In This STEP
1. **The quarantine rule forbade archiving.** The first version required the reason present
   exactly while the status was `quarantined`, so moving a quarantined row to `archived` failed
   `files_quarantine_pair_check` although the guard allows the move. The rule is now two
   implications: a `quarantined` row must carry its reason, and a reason is legal only on a
   `quarantined` or an `archived` row, so an archive keeps the history.
2. **Two predicted numbers were one low.** The schema holds 240 indexes after this migration,
   not 239, and the comment count includes the table comment: 22 column comments plus the table
   comment. Both are measured by the proof, not counted by hand.
3. **A probe built the key from `uuid.hex`.** `files_tenant_path_check` compares against the
   text form of the company id, which is hyphenated, so the first valid seed was refused and
   the constraint was right. The probe now uses `str(uuid)`, and the refusal is a tested
   behaviour.

## Decisions And Limits Left For Later STEPs
1. **The adapters are not here.** STEP 100-105 read this row, encrypt the bytes, put them in
   Supabase Storage or Amazon S3 under the stored key, and sign a short lived link; the table
   only keeps the three facts a signature needs.
2. **The signed URLs and the upload route are a service.** No route, no policy of who may
   download, and no TTL is written here; the lifetime is a setting for the adapter STEPs.
3. **Magic byte reading is the adapter's.** This table records that the verdict happened and
   when, and refuses a `ready` row without it; it cannot read a byte.
4. **Size limits per purpose and link lifetimes are settings.** `config/app.ts` has no storage
   section, so the schema carries the same 50 MB ceiling the KYC documents use and nothing else.
5. **The access audit entry is the service's.** Section 21 asks every access to be audit logged;
   `audit_logs` of STEP 017 is that chain, and the service that signs a link writes to it.
6. **Versioning and backup are section 31.** An operations STEP of 244-250 can add a supersede
   column in its own migration for the "versioned or backed up" line; nothing here blocks it.
7. **`kyc_documents` is untouched.** STEP 028 keeps its own key, hash, type and size, and
   migrations are append only; a future unification would be a data migration, not an edit.
8. **The permissive policies are STEP 035's.** The table is default-deny, so nobody reads it yet
   except the service role; the merchant library policy belongs to that STEP.

## Next Chat Notes
1. Next is STEP 032 - Migration for email settings, templates, send logs, support tickets, CMS
   and blog pages, company accounting and compliance calendar tables. Read section 22 and the
   sections it names, and keep every table default-deny with its own policy.
2. Keep the sub-steps and the approval between them, and ask the owner before starting.
3. Measure every shape with a script before writing the handoff numbers; this STEP caught two
   counted numbers and one rule this way.
4. `npm run check:migrations` catches a missing required column, a missing `commit;` and a
   policy that does not refuse reads and writes; the four probes above are the evidence.
