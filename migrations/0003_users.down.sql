-- path: migrations/0003_users.down.sql
-- STEP 013 - rollback for 0003_users.sql.
--
-- Drops the users table and everything it owns: its constraints, the two indexes, the policy and
-- the row metadata trigger. `companies`, `job_queue` and the two functions stay, because they
-- belong to earlier migrations.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.users;

commit;
