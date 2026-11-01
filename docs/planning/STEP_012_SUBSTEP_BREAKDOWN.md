// path: docs/planning/STEP_012_SUBSTEP_BREAKDOWN.md
# STEP 012 - Sub-Step Breakdown

Working notes taken before any SQL was written. Nothing in this document is a substitute for
`docs/handoffs/STEP_012_COMPLETED.md`, which records what was actually proven.

## 1. Scope Confirmed From The Source Documents

### STEP 012 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for companies and background jobs queue tables with tenant fields and version
  column".
- Category: Database Schema and Row Level Security (STEP 012-036).
- File Ownership Rules, line 47: "Database STEPs 012-036 own only their numbered migration files
  in migrations/." Line 66 adds that a shared file such as the migrations index changes only
  inside its owning STEP.
- MASTER_PROMPT, production readiness: "Every STEP that adds a database migration must run the
  migration and its rollback on a clean database and record the result in the handoff file."

### Feature list sections that fix the shape
- Section 1, platform foundations: "Every table has id UUID v7, company_id, created_at,
  updated_at, deleted_at and version." "RLS enabled with default-deny policy on every table."
  "Optimistic locking on every editable record." "USD only, numeric(18,4)" (no money column in
  this STEP, so no numeric type appears).
- Section 27, background jobs: provisioning, email and retry, recurring invoices, webhooks,
  settlement release, subscription attempts, reconciliation, token cleanup, audit hash and
  compliance alerts. The queue therefore has to hold a named job, a payload, an attempt counter,
  a delay, a lease and an error code, and it has to be claimable without a full table scan.
- Section 28, performance: "indexes on lookup columns", "no queries inside loops", "request
  handlers validate, write minimal rows and enqueue". That is what decides the partial indexes
  below.
- Section 32, monitoring: stalled work raises an alert, which is the `lease_expires_at` column
  and the running-lease index.

### What STEP 011 left that this STEP must fit
`lib/jobs/queue.ts` defines the `JobQueue` port and `JobRecord`: `id`, `name`, `payload`,
`status` (`pending | running | retrying | completed | failed`), `attempt`, `maxAttempts`,
`idempotencyKey`, `traceId`, `availableAtEpochMs`, `leaseExpiresAtEpochMs`, `lastErrorCode`,
`createdAtEpochMs`, `updatedAtEpochMs`. The table below is that record, in SQL, plus the audit
columns the feature list requires. STEP 012 does **not** implement the SQL store: the port's file
belongs to STEP 011, and no STEP in the plan gives the database steps a code surface. The
migration must make the store possible, and the store is a later STEP's decision.

### What exists today (measured before coding)
- `migrations/` contains one file, `migrations/README.md`, which already fixes the naming
  (`0001_short_description.sql` plus `0001_short_description.down.sql`), the seven columns, RLS
  and the rollback rule.
- No database client, no Supabase SDK, no SQL file, no seed anywhere in the repository.
- `config/app.ts` holds the job limits the queue uses (5 attempts, 15 s base, 900 s ceiling,
  120 s timeout, 4 worker slots, 300 s stall window); `config/server.ts` reads `DATABASE_URL`
  from the environment contract. Nothing in this STEP reads either.
- The logger's request id pattern is `^[A-Za-z0-9._-]{8,128}$` with a `req_` prefix
  (`lib/logger/context.ts`), which is what a `trace_id` column has to accept.
- The error catalog lives in code (`lib/errors/codes.ts`), not in the database.

## 2. The Proof Environment, Stated Up Front

There is no database in this sandbox, no Docker and no Supabase CLI. The proof therefore runs on
a real PostgreSQL server, not on an emulator: PostgreSQL 16.2 from the `pgserver` Python wheel,
started locally, with `psycopg` as the client. It is PostgreSQL, so syntax, transactions,
triggers, constraints, partial indexes, generated columns and row level security behave as they
do in Supabase; what it does not have is Supabase's `auth` schema, `supabase_admin` roles and
`extensions` schema, so the migration is written to need none of them:

- `gen_random_uuid()` is core since PostgreSQL 13, so no `pgcrypto` extension is created.
- UUID v7 is not built in before PostgreSQL 18, so this STEP defines `public.uuid_generate_v7()`
  itself rather than depending on the Supabase version the project happens to be on.
- No `auth.uid()`, no `auth.users` reference and no role other than `public` is named, because
  none of them exist in a category that only creates tables.
- Every statement is valid in PostgreSQL 15 and 16.

A spike of the UUID v7 function was run in this environment before the design was fixed: the
generated ids carry version nibble `7`, variant nibble `8`/`9`, a millisecond timestamp prefix
(`01a18e15-bbe0-...`), two generated ids differ, and one sorts below the next.

## 3. Design Decisions Taken Before Coding

1. **Two tables, no guesses.** `public.companies` (the tenant row) and `public.job_queue` (the
   background work). No column is added for a feature that a later STEP owns: company status,
   country, KYC state, plan, branding and suspension arrive with STEPs 013-036 and after, as new
   migrations. A column added now would be a claim on someone else's scope, and a wrong one.
2. **UUID v7 through one function.** `public.uuid_generate_v7()` builds a v7 from the current
   millisecond and a random tail. Every table uses it as its default, so ids are time ordered
   without a sequence and without leaking a counter to a client.
3. **The audit columns are uniform.** `id`, `company_id`, `created_at`, `updated_at`,
   `deleted_at`, `version` on both tables. For `companies` the row *is* the tenant, so
   `company_id` is a stored generated column equal to `id`. That keeps the feature list rule
   literally true on every table, gives later joins one column name to use, and needs no
   self-referencing foreign key that would have to be deferred on insert.
4. **`job_queue.company_id` is nullable, on purpose.** Platform work (audit hash root,
   reconciliation across tenants, compliance calendar) has no tenant. A `not null` here would
   force a fake "platform company" row, which is exactly the kind of lie that outlives its
   author. The column is a foreign key to `companies(id)`, and the tenant-scoped queries a later
   STEP writes will filter on it.
5. **A tenant row is never hard deleted.** `deleted_at` is the delete; the foreign key from
   `job_queue` stays `restrict` (the default), so a careless `delete from companies` fails
   instead of orphaning work.
6. **`version` and `updated_at` are maintained by trigger.** `public.set_row_metadata()` sets
   `updated_at = now()` and `version = old.version + 1` on every update. The application still
   reads the version it was given and writes `where id = $1 and version = $2` for optimistic
   locking; the trigger guarantees the counter cannot move backwards even for a hand written
   `update`, and it removes `updated_at` from every call site.
7. **RLS is enabled with an explicit default-deny policy.** `alter table ... enable row level
   security` plus `create policy <table>_default_deny for all to public using (false) with check
   (false)`. With zero policies, RLS already denies everything, but an explicit policy is
   provable: the gate can read `pg_policies`, and a later STEP that adds a real policy adds a
   permissive one beside it instead of wondering whether the deny was ever there. The migration
   does not use `force row level security`, because the table owner and the service role must
   still be able to migrate and to enqueue; that boundary is a deployment concern.
8. **The queue status vocabulary matches the port exactly.** A check constraint lists `pending`,
   `running`, `retrying`, `completed` and `failed`. A sixth value in the database would be a
   value the worker cannot handle.
9. **A claim is a lease, expressed as a constraint.** `check ((status = 'running') =
   (lease_expires_at is not null))` makes "running without a lease" and "settled with a lease"
   impossible rows, which is the single invariant STEP 011's worker relies on.
10. **Idempotency is unique per tenant without a sentinel row.** Two partial unique indexes: one
    on `(company_id, idempotency_key)` where both are not null, one on `(idempotency_key)` where
    `company_id` is null. A magic all-zero company id was rejected: it would have to exist in
    `companies`, and it would appear in reports.
11. **The claim path has its own partial indexes.** `(available_at, created_at)` where
    `status in ('pending','retrying') and deleted_at is null`, and `(lease_expires_at)` where
    `status = 'running' and deleted_at is null`. The worker's two hot queries — "next eligible"
    and "which lease expired" — then read an index that holds only the rows they can return. The
    `for update skip locked` clause itself belongs to the store STEP; this migration only makes
    it cheap.
12. **`last_error_code` is text, without a check against a code list.** The catalog lives in
    `lib/errors/codes.ts` and grows in a code change; a check constraint would turn every new
    code into a migration. Length is bounded (64), because the column is a code, not a message.
13. **`payload` is a jsonb object.** `check (jsonb_typeof(payload) = 'object')`, because every
    job in STEP 011 is registered with a `zod` object schema. A scalar payload would fail in the
    worker, after the row was written.
14. **`trace_id` accepts exactly what the logger generates.** `^req_[A-Za-z0-9._-]{8,128}$`, so a
    job's log lines and the request that caused it share one id, and a malformed id is refused at
    insert rather than carried into a log line.
15. **Migration files are transactions.** Every file starts with `begin;` and ends with
    `commit;`, so a manual `psql -f` is atomic and a half-applied migration cannot exist. The
    Supabase CLI wraps files in a transaction of its own; a nested `begin` there is a warning,
    not an error, and the explicitness is worth more than the warning.
16. **A static gate for migrations, in `migrations/`.** `migrations/verify.ts` (`npm run
    check:migrations`) checks numbering, forward/rollback pairing, the transaction wrapper, the
    seven columns on every table, that every created table enables RLS, that no forward file
    drops or truncates anything, and that the files are ASCII. It is a static gate on purpose: it
    runs everywhere without a database, while the real apply-and-rollback proof stays in the
    handoff with its transcript.
17. **Two migrations, not one.** `0001_companies.sql` owns the company table and the two shared
    functions; `0002_job_queue.sql` owns the queue. Rollback is then per table, in reverse order,
    and a later reader learns which part created what.

## 4. The Schema This Produces

`public.companies`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | generated always as `(id)` stored, not null |
| name | text | not null, trimmed, 1-120 characters |
| slug | text | not null, `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, unique while not deleted |
| created_at, updated_at | timestamptz | not null, default `now()` |
| deleted_at | timestamptz | null until deleted |
| version | integer | not null, default 1, `> 0` |

`public.job_queue`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for platform jobs, references `companies(id)` |
| name | text | not null, `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$`, at most 120 characters |
| payload | jsonb | not null, default `{}`, must be an object |
| status | text | not null, default `pending`, one of the five port values |
| attempt | integer | not null, default 0, `0 <= attempt <= max_attempts` |
| max_attempts | integer | not null, default 5, `1 <= max_attempts <= 20` |
| idempotency_key | text | null, 1-200 characters, unique per tenant |
| trace_id | text | not null, `^req_[A-Za-z0-9._-]{8,128}$` |
| available_at | timestamptz | not null, default `now()` |
| lease_expires_at | timestamptz | null exactly when the row is not running |
| last_error_code | text | null, at most 64 characters |
| created_at, updated_at | timestamptz | not null, default `now()` |
| deleted_at | timestamptz | null until deleted |
| version | integer | not null, default 1, `> 0` |

Indexes: `companies_slug_key` (unique, partial), `job_queue_claim_idx`, `job_queue_lease_idx`,
`job_queue_idempotency_company_key`, `job_queue_idempotency_platform_key`,
`job_queue_company_created_idx`. Both tables carry `enable row level security` and a
`<table>_default_deny` policy.

## 5. The Five Sub-Steps

Each sub-step ends with its own proof, and the next one starts only after the owner's approval.

### 012.1 - Inventory, decisions and ownership (this document)
Read the STEP, the feature sections, the previous handoff and the current `migrations/`; measure
what exists; fix the schema and the proof environment above. No code.

### 012.2 - `0001_companies.sql` and its rollback
Create the UUID v7 function, the row metadata trigger function, the `companies` table with its
constraints, the slug index, RLS and the default-deny policy, plus comments. The rollback drops
the policy, the table and both functions. Proof: on a clean database, apply `0001` forward,
inspect the catalog (`\d+`, `pg_policies`, `pg_indexes`), insert two companies and show two
distinct v7 ids and the self-tenant `company_id`, update one row and show `version` moved to 2 and
`updated_at` changed, then apply the rollback and show the table and functions are gone.

### 012.3 - `0002_job_queue.sql` and its rollback
Create the queue table, its constraints, its five indexes, the trigger, RLS and the default-deny
policy, plus comments. Rollback drops them. Proof: forward apply on the database that already has
`0001`, a platform job with a null `company_id`, a tenant job, the two idempotency indexes
refusing a duplicate per tenant while allowing the same key for a different tenant, a status
outside the five refused, a running row without a lease refused, and the rollback removing the
table and leaving `companies` intact.

### 012.4 - RLS, the migrations gate and the full clean run
Prove the deny is real: create a plain role without `bypassrls`, grant it `select`, and show it
reads zero rows from both tables while the owner sees its rows. Add `migrations/verify.ts` and
`npm run check:migrations` (the `package.json` line is requested in the handoff, as the rules
require), then apply `0001` + `0002` to a brand new database, roll both back in reverse order and
show a clean catalog. Exercise the two queries the store will use: next eligible job with
`for update skip locked`, and expired leases.

### 012.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` (conventions that now exist, the function names, the proof command
line), add a database section to the root README, run `npm run verify`, write
`docs/handoffs/STEP_012_COMPLETED.md` with the transcripts, commit as
"STEP 012: Migration for companies and background jobs queue tables with tenant fields and
version column", push, and stop.

## 6. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0001_companies.sql | created in 012.2 |
| migrations/0001_companies.down.sql | created in 012.2 |
| migrations/0002_job_queue.sql | created in 012.3 |
| migrations/0002_job_queue.down.sql | created in 012.3 |
| migrations/verify.ts | created in 012.4 |
| migrations/README.md (the migrations index) | modified in 012.5 |
| package.json (the `check:migrations` script and the verify chain) | modified in 012.4, recorded as a request |
| README.md (a database section) | modified in 012.5 |
| docs/planning/STEP_012_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_012_COMPLETED.md | created in 012.5 |

Not owned here, therefore untouched: every `lib/` module, including the `JobQueue` port and its
in-memory store (STEP 011), `config/` (STEP 005 and 011), the environment contract (004), the
catalog (006), the logger (007), the error catalog (008), the lint matrix (009), the shell (010),
every seed, and every table that STEPs 013-036 own.

## 7. Open Points The Owner May Want To Change

1. `job_queue.company_id` is nullable so platform jobs can exist without a fake tenant.
2. Both tables carry an explicit default-deny policy named `<table>_default_deny`, which a later
   STEP keeps and works beside rather than replacing.
3. `migrations/verify.ts` adds a tenth gate and one line to `package.json`; the rules call
   `package.json` integrator-owned, so the change is also recorded as a request in the handoff.
4. `companies` starts with four business columns (`name`, `slug` and the audit set). Everything
   else - status, country, plan, branding, KYC - waits for the STEP that owns it.

## 8. Outcome

All five sub-steps were implemented in order with the owner's approval, and the design above held
with two additions that the proof asked for:

- The claim query needed `(available_at, created_at)` to be useful only for waiting rows, and the
  stall query only for running rows; both partial indexes were re-checked with `explain` and the
  plan is an index scan (`job_queue_claim_idx`), not a sequential one.
- The version trigger turned out to be stronger than planned: a hand written
  `update ... set version = 0` writes 2, so the counter cannot move backwards outside the
  application either. The proof records that rather than a constraint violation.

No column was added for a later STEP's feature; `companies` still holds only `name`, `slug` and
the audit set. See `docs/handoffs/STEP_012_COMPLETED.md` for the transcripts.
