-- path: migrations/0002_job_queue.down.sql
-- STEP 012 - rollback for 0002_job_queue.sql.
--
-- Drops the queue table and everything it owns: its constraints, the five indexes, the policy and
-- the row metadata trigger. `companies` and the two functions the table borrows stay, because
-- they belong to 0001 and this rollback must not touch another migration's objects.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.job_queue;

commit;
