// path: migrations/README.md
# migrations/

Owner: STEP 012-036 and every later STEP that adds a table.

Append-only numbered SQL migrations applied with the Supabase CLI against the project of
the current environment.

Naming:
- Forward: 0001_short_description.sql, 0002_short_description.sql, ...
- Rollback: 0001_short_description.down.sql next to its forward file.

Rules:
- A committed migration is never edited; a correction is a new migration.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version,
  with row level security enabled and a default deny policy.
- Every migration is applied and rolled back on a clean database and the result is
  recorded in the handoff file of the STEP that added it.
- This folder holds no migration yet: the first one belongs to STEP 012.
