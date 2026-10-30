// path: docs/handoffs/STEP_013_COMPLETED.md
# STEP 013 Completed - Handoff

## STEP
- Number and title: STEP 013 - Migration for users and role assignment tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012, which created
  `public.companies`, `public.uuid_generate_v7()`, `public.set_row_metadata()` and the migrations
  gate, and whose handoff fixes the conventions this STEP follows (one transaction per file, a
  `.down.sql` beside each forward file, the six audit columns, RLS plus a default-deny policy).
  From the foundation category it depends on STEP 007 (the request id and log redaction rules,
  untouched here) and STEP 011 (the job limits and the `JobRecord` contract, also untouched).

## Files
- Created:
  - migrations/0003_users.sql - the `users` table with its fourteen constraints, the email and
    company indexes, the row metadata trigger, row level security and the default-deny policy.
  - migrations/0003_users.down.sql - drops the table and nothing else.
  - migrations/0004_role_assignments.sql - the `role_assignments` table with its eleven
    constraints, the two live indexes, the trigger, row level security and its policy.
  - migrations/0004_role_assignments.down.sql - drops the table and nothing else.
  - docs/planning/STEP_013_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_013_COMPLETED.md.
- Modified:
  - migrations/README.md - the inventory rows for `0003` and `0004`, a twelfth rule for the role
    vocabulary and the grant history, and the renumbered rule list.
  - README.md - the "Database schema and migrations" section now describes the accounts and the
    role assignments, and the RLS bullet speaks for every table rather than two.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: `migrations/0001` and
  `0002`, every `lib/` module, `config/`, the environment contract, the catalog, the logger, the
  error catalog, the lint matrix, the shell, the sessions table (015), login attempts and locks
  (016), the audit log (017), the KYC tables (028), the permissive RLS policies (035) and every
  code STEP. `package.json` is untouched: the migrations gate already covers new files.

## Database
- Migrations added (file names): `0003_users.sql` with `0003_users.down.sql`, and
  `0004_role_assignments.sql` with `0004_role_assignments.down.sql`. Together they create two
  tables, two triggers, six indexes, two policies and 19 comments.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. Both rollbacks
  were applied in reverse order to a populated database; afterwards the catalog reported 0 public
  tables, 0 policies, 0 functions in `public` and 0 custom triggers, and applying all four forward
  files again to a second empty database recreated exactly `companies`, `job_queue`,
  `role_assignments` and `users`. The transcripts are in the proof section. The environment has no
  Docker and no Supabase CLI, so the server was a real PostgreSQL 16.2 started locally from the
  `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none. The TOTP encryption key is not read here; the
  column holds ciphertext and the key stays in the environment contract of the auth STEP.
- Secrets handled (names only, never values): none. The proof inserted synthetic password and
  backup code hashes, which are fixtures in a throwaway local database, not credentials.

## Packages
- Package requests for the integrator (name, reason), or none: none. No dependency and no
  `package.json` change.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised on PostgreSQL 16.2.

  **1. A documented conflict, resolved the way the rules require.** REVISED_FEATURE_LIST_V2 lists
  the office roles as `super_admin`, `ceo`, `compliance_kyc`, `support` and `blogger`, without
  `finance_ops`. FEATURE_LIST.md section 2 lists `finance_ops`. MASTER_PROMPT says FEATURE_LIST.md
  wins and the conflict is recorded here, so the role check contains all seven names:
  `super_admin`, `ceo`, `compliance_kyc`, `finance_ops`, `support`, `blogger`, `owner`. A proof
  write with `finance_ops_lead` and another with `client` were both refused by
  `role_assignments_role_check`.

  **2. The account table exists with the required shape.** After applying `0001` to `0003` on a
  clean database, `information_schema.columns` for `public.users` reported sixteen columns:
  `id uuid NOT NULL default uuid_generate_v7()`, `company_id` (nullable), `email`, `phone`,
  `full_name`, `password_hash`, `password_updated_at`, `email_verified_at`,
  `totp_secret_ciphertext`, `totp_confirmed_at`, `backup_code_hashes jsonb NOT NULL default '[]'`,
  `status NOT NULL default 'active'`, the three audit timestamps and `version`. Fourteen
  constraints were present and no table-level default was missing.

  **3. Identity rules are enforced by the database.** Eight writes were attempted and all eight
  were refused by the named constraint: a duplicate email by `users_email_key`, `Mixed@Case.example`
  by `users_email_format_check`, `not-an-email` by the same check, `01700000000` by
  `users_phone_format_check`, ` Padded ` by `users_full_name_check`, a three character hash by
  `users_password_hash_check`, `status = 'locked'` by `users_status_check`, and a `company_id` no
  company owns by `users_company_fkey`.

  **4. A closed account keeps its address.** After `status = 'closed'` and `deleted_at = now()` on
  the office user, a fresh signup with that same email was still refused by `users_email_key`,
  which is the database's reading of "one person holds exactly one account".

  **5. The second factor cannot be faked.** A confirmation without a secret was refused by
  `users_totp_confirmation_check`; an array of 21 backup code hashes was refused, and a jsonb
  object instead of an array was refused, both by `users_backup_code_hashes_check`. A secret, a
  confirmation and three hashes were accepted together, and the row's `version` moved from 1 to 2.

  **6. The version trigger owns the counter.** A hand written `update ... set version = 0` on the
  owner row did not produce 0: the trigger wrote the next value (3, after the 2FA update) and
  `updated_at` moved forward, exactly as the `companies` proof recorded in STEP 012.

  **7. The assignment table exists with the required shape.** `public.role_assignments` reported
  eleven columns, a primary key, three foreign keys (`company_id` to `companies`, `user_id` and
  `granted_by` to `users`), the seven name role check, the owner scope check, the revoke ordering
  check and the audit column checks, plus the two live partial indexes and the trigger.

  **8. Role scope is a constraint, not a convention.** An owner grant without a company was
  refused by `role_assignments_owner_scope_check`, and a `support` grant carrying a company was
  refused by the same check. A valid owner grant stored `company_id`, `granted_by` and
  `version = 1`; a valid `super_admin` grant stored a null company; the same admin could hold a
  second role (`compliance_kyc`) without conflict.

  **9. History is kept, duplicates are not.** A duplicate live owner grant was refused by
  `role_assignments_live_key`; after revoking it (`revoked_at = now()`, `version` 2), a fresh owner
  grant was accepted (`version` 1, `revoked_at` null), leaving one live grant and one revoked grant
  for that user and role. A revocation timestamped before the grant was refused by
  `role_assignments_revoked_after_grant_check`.

  **10. The foreign keys refuse imaginary actors.** A grant for a user that does not exist was
  refused by `role_assignments_user_fkey`, and a grant by a user that does not exist by
  `role_assignments_granted_by_fkey`.

  **11. The lookup the office will run is indexed.** The "who is the owner of this company" query
  returned `owner@etaworks.example`, and `explain (costs off)` reported
  `Index Scan using role_assignments_company_role_idx`, not a sequential scan.

  **12. The three tables agree with each other.** With a tenant owner and a platform admin seeded,
  the live grants joined across `role_assignments`, `users` and `companies` produced exactly the
  two expected rows; the counts of "owner grants whose user belongs to another company", "platform
  grants held by a tenant user" and "users without any live role" were all **0**.

  **13. Row level security denies both new tables.** A role `gate_reader` without `bypassrls` was
  granted `usage` and `select`/`insert`/`update` on both tables. Acting as it, the visible counts
  were **0** for `users` and **0** for `role_assignments`, an `update ... returning` affected **0**
  rows, and both inserts were refused with `new row violates row-level security policy for table
  "users"` and `... "role_assignments"`. The owner still saw its two users.

  **14. The gate covers the new files without a change.** `npm run check:migrations` reports
  `migrations gate passed: 123 checks, 4 migrations, 4 tables, every forward file transactional and
  default-deny`. Three deliberate regressions were applied, run and reverted, each caught with its
  own message:
  - `alter table public.role_assignments enable row level security;` removed ->
    `0004_role_assignments.sql: table role_assignments must enable row level security in this file`;
  - the `version` column removed from `users` ->
    `0003_users.sql: table users is missing the required column version`;
  - `0004_role_assignments.sql` renamed to `0006_role_assignments.sql` ->
    `migration numbering must be contiguous from 0001: expected 0004, found 0006`, plus the
    missing rollback and the orphaned rollback.
  Restoring each mutation returns the green line above.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable, no
  surface changed.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not
  applicable, no route changed. The cross-tenant boundary this STEP creates is the owner scope
  check and the `company_id` foreign key, both proven in items 8 and 12; the policies that let an
  office user read across tenants belong to STEP 035.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, no money
  column exists yet.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Lint result: pass, `npm run lint` exits 0 with the STEP 009 matrix. No `.ts` file changed in this
  STEP, and `.sql` files are outside the lint surface by design.
- Build result for the touched area: pass on Node.js 26.13.0. The route table is unchanged
  (`○ /`, `○ /_not-found`, `ƒ /api/health`, `ƒ /api/jobs/health`) because this STEP adds no route.
- `npm run verify` runs eleven gates plus typecheck, lint and build, and exits 0 in about 14
  seconds:
  `structure gate passed: 16 directories, 13 root files, 68 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 10 sections, 28 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 36 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`,
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`,
  `shell gate passed: 98 checks, 12 files scanned, no colour literal, no palette step, theme
  script and provider agree`,
  `jobs gate passed: 110 checks, 4 worker slots, 5 default attempts, store "memory"`,
  `migrations gate passed: 123 checks, 4 migrations, 4 tables, every forward file transactional and
  default-deny`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change. The proof server was
  PostgreSQL 16.2.

## Next
- Next STEP number: STEP 014 - Migration for office permissions, delegation, announcements and
  announcement dismissals tables. Not started. This chat ends here as the owner asked, and STEP 014
  needs the owner's consent.
- Anything the next chat must know:
  1. `users` and `role_assignments` exist and are proven. A new table that belongs to a person
     references `users(id)`; a table that belongs to a tenant references `companies(id)`; a table
     that belongs to both carries `company_id` as well, as `role_assignments` does.
  2. `company_id` is nullable only for platform scope: office staff have no company and platform
     roles carry none. A new tenant table should keep it `not null` unless platform wide rows are
     genuinely expected, as `job_queue` and `users` document.
  3. A role is a row in `role_assignments`, never a column on `users`. A permission change is a new
     row with `granted_by`, and a removal sets `revoked_at`; nothing is deleted. The live rows are
     the answer, and `role_assignments_live_key` prevents two live grants of one role.
  4. The role vocabulary is the seven names of FEATURE_LIST.md section 2, including `finance_ops`.
     `client` is not a role, because a client is a tokenized link with no login. Adding or removing
     a role is a new migration that replaces the check constraint.
  5. `(role = 'owner') = (company_id is not null)` is enforced. An office role with a company, or an
     owner without one, is refused by the database; do not relax it in code.
  6. Email is unique for ever, so a closed account keeps its address. A support tool that "frees"
     an email by deleting the row would break the one person one account rule and the audit trail;
     the row is soft closed with `status` and `deleted_at` instead.
  7. 2FA state lives on `users`: `totp_secret_ciphertext` (AES-256-GCM ciphertext, the key is in the
     environment), `totp_confirmed_at` (never set without a secret) and `backup_code_hashes` (at
     most 20 hashes, replaced as a whole). The auth STEP reads and writes these; it must never
     store a plaintext secret or a plaintext backup code.
  8. A login lock is not a user status. `status` has `active`, `suspended` and `closed`; the
     temporary, self clearing lock of section 22 belongs to STEP 016 and must not be modelled by
     flipping `status`.
  9. Both tables are default-deny for everyone except the owner and the service role. STEP 035 adds
     the permissive policies for office roles and owner self access; until then, any query through
     an authenticated client returns nothing, which is the intended safe default.
  10. Still open for their owners: office permissions and delegation (014), sessions (015), login
     locks (016), the audit log (017), KYC (028), the permissive RLS policies (033-035) and the
      super_admin bootstrap (036).
