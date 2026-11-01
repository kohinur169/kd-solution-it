-- path: migrations/0004_role_assignments.down.sql
-- STEP 013 - rollback for 0004_role_assignments.sql.
--
-- Drops the assignment table and everything it owns: its constraints, the two indexes, the policy
-- and the row metadata trigger. `users`, `companies`, `job_queue` and the two functions stay,
-- because they belong to earlier migrations.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.role_assignments;

commit;
