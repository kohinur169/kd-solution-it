-- path: migrations/0057_files.down.sql
-- STEP 031 - rollback for 0057_files.sql.
--
-- Drops the file table with its constraints, its four indexes, the policy and the two triggers,
-- then the guard this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.files;

drop function if exists public.files_guard_state();

commit;
