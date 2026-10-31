-- path: migrations/0051_sanctions_screenings.down.sql
-- STEP 028 - rollback for 0051_sanctions_screenings.sql.
--
-- Drops the screening table with its constraints, indexes, policy and two triggers, then the guard
-- this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.sanctions_screenings;

drop function if exists public.sanctions_screenings_guard_state();

commit;
