-- path: migrations/0056_velocity_counters.down.sql
-- STEP 030 - rollback for 0056_velocity_counters.sql.
--
-- Drops the counter table with its constraints, indexes, policy and two triggers, then the guard
-- this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.velocity_counters;

drop function if exists public.velocity_counters_guard_count();

commit;
