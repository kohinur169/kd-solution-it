-- path: migrations/0050_ubo_records.down.sql
-- STEP 028 - rollback for 0050_ubo_records.sql.
--
-- Drops the owner table with its constraints, indexes, policy and three triggers, then the two guards
-- this file created. It runs before the document and submission rollbacks, because every owner names a
-- submission.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.ubo_records;

drop function if exists public.ubo_records_guard_total();

drop function if exists public.ubo_records_guard_state();

commit;
