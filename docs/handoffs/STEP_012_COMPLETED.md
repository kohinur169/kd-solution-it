// path: docs/handoffs/STEP_012_COMPLETED.md
# STEP 012 Completed - Handoff

## STEP
- Number and title: STEP 012 - Migration for companies and background jobs queue tables with
  tenant fields and version column
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): this is the first STEP of
  the category, so there is no earlier database handoff. It depends on the foundation STEPs only:
  STEP 001 (the `migrations/` folder and its conventions), STEP 004 (the environment contract that
  supplies `DATABASE_URL`; not read here), STEP 007 (the request id pattern a `trace_id` column
  must accept) and STEP 011 (the `JobRecord` and `JobQueue` contract this table stores, and the
  job limits in `config/app.ts` that the column defaults mirror).

## Files
- Created:
  - migrations/0001_companies.sql - `public.uuid_generate_v7()`, `public.set_row_metadata()`, the
    `companies` table, its slug index, the row metadata trigger, row level security and the
    default-deny policy.
  - migrations/0001_companies.down.sql - drops the table and then the two functions.
  - migrations/0002_job_queue.sql - the `job_queue` table, its fourteen constraints, seven
    indexes, its trigger, row level security and the default-deny policy.
  - migrations/0002_job_queue.down.sql - drops the queue table and nothing else.
  - migrations/verify.ts - the gate behind `npm run check:migrations`.
  - docs/planning/STEP_012_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_012_COMPLETED.md.
- Modified:
  - migrations/README.md - the inventory of the two migrations, the transaction rule, the UUID v7
    and row metadata functions, the default-deny rule, the commands and what the gate refuses.
  - package.json - `check:migrations` added; `verify` now runs the migrations gate after the job
    gate. This file is integrator-owned, so the change is recorded under Packages as well.
  - README.md - a "Database schema and migrations" section and the commands table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations index (`migrations/README.md`) and the gate that
  lives beside them. Not touched: every `lib/` module, including the `JobQueue` port and its
  in-memory store (STEP 011), `config/` (005 and 011), the environment contract (004), the catalog
  (006), the logger (007), the error catalog (008), the lint matrix (009), the shell (010), and
  every table STEPs 013-036 own.

## Database
- Migrations added (file names): `0001_companies.sql` with `0001_companies.down.sql`, and
  `0002_job_queue.sql` with `0002_job_queue.down.sql`. Together they create two tables, two
  functions, two triggers, nine indexes, 21 constraints, two policies and 22 comments.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The forward files
  were applied to a brand new database, exercised, and both rollbacks ran in reverse order; the
  catalog afterwards reported 0 public tables, 0 of the two functions, 0 policies and 0 custom
  triggers. The full transcript is in the proof section below. No Docker, no Supabase CLI and no
  emulator exists in this environment, so the server was a real PostgreSQL 16.2 started locally
  from the `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none. `DATABASE_URL` already exists in the
  environment contract (STEP 004); this STEP reads nothing.
- Secrets handled (names only, never values): none. The migrations contain no literal, no role, no
  grant and no password, and the proof ran against a local cluster with a socket connection.

## Packages
- Package requests for the integrator (name, reason), or none: **one**, recorded rather than
  silently assumed. `package.json` received one line - `"check:migrations": "node
  migrations/verify.ts"` - and the `verify` chain now calls it after `check:jobs`. The rules mark
  `package.json` integrator-owned; this is the request, and the change is already in the tree so
  the gate runs. No dependency was added: the gate uses `node:fs/promises`, `node:process` and
  `node:url` only.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised on PostgreSQL 16.2.

  **1. The tenant table exists with the required shape.** After applying `0001` to a clean
  database, `information_schema.columns` for `public.companies` reported exactly: `id uuid NOT
  NULL default uuid_generate_v7()`, `company_id uuid NOT NULL` (generated), `name text NOT NULL`,
  `slug text NOT NULL`, `created_at`/`updated_at` `timestamptz NOT NULL default now()`,
  `deleted_at timestamptz NULL`, `version integer NOT NULL default 1`. Seven constraints were
  present: primary key on `id`, name length (1-120), name trimmed, slug format, `version > 0`,
  `updated_at >= created_at`, and `deleted_at is null or deleted_at >= created_at`.

  **2. UUID v7 is real.** Two inserted companies returned `01a18e1a-cc40-782c-...` and
  `01a18e1a-cc43-7a45-...`: the version nibble is `7`, the variant nibble is `8` and `9`, the
  first 48 bits are the current millisecond, the two ids differ, and the earlier row sorts below
  the later one.

  **3. The row is its own tenant.** `company_id` equalled `id` on both rows without being written
  by the insert, which is what a generated column means, and the feature list rule "every table
  has company_id" is therefore true on the tenant table itself.

  **4. The version trigger owns the counter.** An update of `name` moved `version` from 1 to 2 and
  `updated_at` forward. A hand written `update ... set version = 0` did not produce 0: the trigger
  wrote 2, so the counter cannot move backwards even outside the application.

  **5. The table refuses bad tenants.** A duplicate slug was refused by
  `companies_slug_key`, an empty name by `companies_name_length_check`, a padded name by
  `companies_name_trimmed_check`, and `Bad Slug` by `companies_slug_format_check`. A soft deleted
  row freed its slug: a second row took `alpha-trading` while the deleted one stayed, two rows in
  total.

  **6. The queue table is the port in SQL.** After applying `0002`, `public.job_queue` reported
  sixteen columns: `id`, `company_id` (nullable, foreign key to `companies(id)`), `name`,
  `payload jsonb NOT NULL default '{}'`, `status text NOT NULL default 'pending'`, `attempt`
  default 0, `max_attempts` default 5, `idempotency_key`, `trace_id`, `available_at`, two
  `lease_expires_at`, `last_error_code`, the three audit timestamps and `version`. Thirteen
  constraints cover the five statuses, the attempt ceiling, the lease invariant, the object
  payload, the job name format, the trace id pattern and the idempotency key length.

  **7. Every row the worker cannot handle is refused.** Eight writes were attempted and all eight
  were refused with the named constraint: `status = 'cancelled'`, `running` without a lease,
  a lease while `pending`, `attempt 6` against `max_attempts 5`, an array payload, `trace-without-prefix`,
  `Email Send` as a name, and a `company_id` that no company owns (foreign key).

  **8. Idempotency is per tenant, and platform work has its own.** A second row with the same
  `(company_id, 'invoice:inv_1')` was refused by `job_queue_idempotency_company_key`; the same key
  under another company was accepted; a platform row with `company_id = null` and key
  `platform:audit:2026-10-30` was accepted once and refused the second time by
  `job_queue_idempotency_platform_key`. No sentinel company row exists anywhere.

  **9. The claim query is concurrent and indexed.** Two sessions ran
  `select ... where status in ('pending','retrying') and deleted_at is null and available_at <= now()
  order by available_at, created_at limit 1 for update skip locked` in open transactions and
  claimed two different rows. `explain (costs off)` for the same query shows
  `Index Scan using job_queue_claim_idx`, not a sequential scan.

  **10. An expired lease is found through its own index.** A running row with a past
  `lease_expires_at` was returned by the stall query
  (`status = 'running' and lease_expires_at <= now()`), and settling it as `retrying` with
  `LEASE_EXPIRED` kept `attempt = 1` and moved `version` to 3. A later `failed` write with
  `VALIDATION_FAILED` recorded the code, and the status counts were `failed 1, pending 2,
  retrying 1`.

  **11. Row level security denies by default.** A role `gate_reader` without `bypassrls` was
  granted `usage` on the schema and `select`/`insert` on both tables. Acting as that role it saw
  **0** rows in `companies` and **0** in `job_queue`, and its insert was refused with
  `new row violates row-level security policy for table "companies"`. The owner still saw its
  rows, which is the boundary the deployment needs for migrations and enqueues.

  **12. Both rollbacks leave a clean database.** Running `0002_job_queue.down.sql` then
  `0001_companies.down.sql` on the populated database left 0 public tables, 0 of the two
  functions, 0 policies and 0 custom triggers. Applying both files again to a second empty
  database recreated exactly `companies` and `job_queue`.

  **13. The gate.** `npm run check:migrations` reports
  `migrations gate passed: 63 checks, 2 migrations, 2 tables, every forward file transactional and
  default-deny`. It also refuses five deliberate regressions, each applied, run and reverted:
  - `alter table public.job_queue enable row level security;` removed ->
    `0002_job_queue.sql: table job_queue must enable row level security in this file`;
  - `begin;` replaced by `start;` -> `0002_job_queue.sql: must start with begin;`;
  - `0002_job_queue.down.sql` moved away -> `0002_job_queue.sql: has no rollback file`;
  - `company_id` renamed to `tenant_id` in `0001` ->
    `0001_companies.sql: table companies is missing the required column company_id`;
  - `delete from public.job_queue ...` added to a forward file ->
    `0002_job_queue.sql: a forward migration never drops or deletes rows`.
  Restoring each mutation returns the green line above.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable, no
  surface changed.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not
  applicable, no route changed. The queue's cross-tenant boundary is the `company_id` foreign key
  and the two idempotency indexes proven in items 8 and 7; the store that reads through them
  belongs to a later STEP, because the `JobQueue` port and its in-memory implementation are owned
  by STEP 011 and no STEP in the plan gives the database steps a code surface.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this STEP
  creates no money column and moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`;
  `migrations/verify.ts` is type checked like every other `.ts` file.
- Lint result: pass, `npm run lint` exits 0 with the STEP 009 matrix; `migrations/verify.ts`
  reports 0 problems, and the `.sql` files are outside the lint surface by design.
- Build result for the touched area: pass on Node.js 26.13.0. The route table is unchanged
  (`○ /`, `○ /_not-found`, `ƒ /api/health`, `ƒ /api/jobs/health`) because this STEP adds no
  route.
- `npm run verify` now runs eleven gates plus typecheck, lint and build, and exits 0 in about 14
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
  `migrations gate passed: 63 checks, 2 migrations, 2 tables, every forward file transactional and
  default-deny`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change. The proof server was
  PostgreSQL 16.2.

## Next
- Next STEP number: STEP 013 - Migration for users and role assignment tables. Not started. This
  chat ends here as the owner asked, and STEP 013 needs the owner's consent.
- Anything the next chat must know:
  1. `public.uuid_generate_v7()` and `public.set_row_metadata()` already exist from `0001`. A new
     table uses `id uuid not null default public.uuid_generate_v7()` and installs the trigger with
     `create trigger <table>_set_row_metadata before update on public.<table> for each row execute
     function public.set_row_metadata();`. Do not redefine the functions; a second definition is a
     different function with the same name and the rollback becomes ambiguous.
  2. Every new table carries `company_id`, `created_at`, `updated_at`, `deleted_at` and `version`,
     enables row level security and creates `<table>_default_deny`. `npm run check:migrations`
     refuses a file that forgets any of those, so the rule is enforced rather than remembered.
  3. `companies.company_id` is generated from `id`, so an insert into `companies` never writes it.
     Any table that references a tenant uses `company_id uuid not null references public.companies
     (id)`; only platform work is allowed a nullable `company_id`, and `job_queue` is the example.
  4. `job_queue` is the SQL form of `lib/jobs/queue.ts`. A change to the port means a new migration
     in a later STEP, never an edit of `0002`. The claim path expects
     `for update skip locked` over the partial index `job_queue_claim_idx`, and an expired lease is
     settled as `retrying` with `last_error_code = 'LEASE_EXPIRED'`; both are proven, neither is
     implemented in code yet.
  5. The status vocabulary in the check constraint is the port's five values. A sixth value - for
     example a manual cancel - needs the port, the worker and a migration in the same STEP.
  6. `last_error_code` is text with a length limit, not an enum against the code catalog. The
     catalog lives in `lib/errors/codes.ts` and grows without a migration, which is the point.
  7. Migration files are one transaction each and applied in ascending order. `psql` needs
     `ON_ERROR_STOP=1`, otherwise a failed statement is reported as success.
  8. There is no SQL store yet: `getJobRuntime()` still builds the in-memory queue, which reports
     `store: "memory"` in `/api/jobs/health`. A later STEP implements `JobQueue` over this table
     and changes that one place.
  9. The proof environment had no database, so PostgreSQL 16.2 was started from the `pgserver`
     wheel. Nothing in the repository depends on it; the commands in `migrations/README.md` work
     against any PostgreSQL 15 or newer, including Supabase.
  10. Still open for their owners: the tables of STEPs 013-036, the SQL job store, and every
      feature STEP that reads these tables.
