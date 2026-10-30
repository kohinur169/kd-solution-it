// path: migrations/README.md
# migrations/

Owner: STEP 012-036 and every later STEP that adds a table.

Append-only numbered SQL migrations applied with the Supabase CLI against the project of the
current environment. STEP 012 and STEP 013 created the first four files; `npm run
check:migrations` keeps them honest.

| File | What it creates |
| --- | --- |
| 0001_companies.sql | `public.uuid_generate_v7()`, `public.set_row_metadata()`, the `companies` tenant table, its slug index, row level security and the default-deny policy |
| 0002_job_queue.sql | The `job_queue` background work table, its seven indexes, its trigger, row level security and the default-deny policy |
| 0003_users.sql | The `users` sign-in accounts table, its email and company indexes, the TOTP and backup code columns, its trigger, row level security and the default-deny policy |
| 0004_role_assignments.sql | The `role_assignments` grant history table for the seven roles, its two live indexes, its trigger, row level security and the default-deny policy |

Every file is paired with `<name>.down.sql`, which undoes exactly what its forward file created and
nothing else.

## Naming
- Forward: 0001_short_description.sql, 0002_short_description.sql, ...
- Rollback: 0001_short_description.down.sql next to its forward file.
- Description: lowercase snake case, ASCII, no spaces.

## Rules

1. A committed migration is never edited; a correction is a new migration.
2. Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with
   row level security enabled and a default-deny policy named `<table>_default_deny`.
3. Every migration is applied and rolled back on a clean database and the result is recorded in
   the handoff file of the STEP that added it.
4. One file is one transaction: the first statement is `begin;`, the last is `commit;`. The
   Supabase CLI runs each file in a transaction of its own, and the explicit pair makes a manual
   `psql -f` atomic too.
5. A forward migration never drops a table, truncates, or deletes rows. Removal of data is an
   operational decision, not a schema change.
6. `id` defaults to `public.uuid_generate_v7()`. PostgreSQL before 18 has no native UUID v7, so
   `0001` defines one; it is `volatile`, it reads `clock_timestamp()`, and it takes its random
   tail from `gen_random_uuid()`.
7. `updated_at` and `version` are maintained by `public.set_row_metadata()`, a before-update
   trigger installed per table. The application still writes `where id = $1 and version = $2`, so
   a stale writer loses; the trigger makes the counter monotonic for anything else that writes.
8. Row level security is enabled and explicitly denied. A STEP that grants access adds a
   permissive policy beside `<table>_default_deny`; it does not remove the deny.
9. No migration creates extensions, roles or schemas. `gen_random_uuid()` is core since
   PostgreSQL 13, and the functions in this folder are schema qualified with an empty
   `search_path` precisely so no extension and no role is needed.
10. The queue table's shape is fixed by the `JobQueue` port in `lib/jobs/queue.ts`, not the other
    way round. Changing a column to suit a store implementation is a design change that starts in
    that port and in a new migration.
11. A role is a row in `role_assignments`, never a column on `users`. A grant is recorded with
    `granted_by`, `granted_at` and `revoked_at`; revoking sets `revoked_at`, it does not delete the
    row, and a later grant of the same role is a new row. The role vocabulary is the seven names in
    FEATURE_LIST.md section 2, and `client` is never one of them because a client cannot sign in.
12. Numbering is contiguous from 0001. A migration is never renumbered after it has been applied
    anywhere.

## Commands

```bash
npm run check:migrations                      # the static gate, also part of npm run verify
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_companies.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_companies.down.sql
```

Apply forward in ascending order and roll back in descending order. `ON_ERROR_STOP=1` matters:
without it `psql` keeps going after a failed statement and reports success for the file.

## What the gate checks

`migrations/verify.ts` reads every file and refuses: a name outside `NNNN_lower_snake.sql`, a gap
or a duplicate in the numbering, a forward file without its rollback (and the reverse), a missing
path comment, a body without the `begin;`/`commit;` pair, non ASCII text, a forward file that
drops or deletes, a created table that misses one of the six required columns, an `id` default
that is not the shared UUID v7 function, a table without `enable row level security` and its
`<table>_default_deny` policy, and a rollback that does not drop the tables its forward creates.

It is static, so it needs no database. Whether the SQL actually applies is proven by running it:
STEP 012 recorded a forward apply, a data level proof of every constraint and both rollbacks on
PostgreSQL 16.2 in `docs/handoffs/STEP_012_COMPLETED.md`.
