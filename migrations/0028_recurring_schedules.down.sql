-- path: migrations/0028_recurring_schedules.down.sql
-- STEP 022 - rollback for 0028_recurring_schedules.sql.
--
-- Drops the recurring schedule table and everything it owns: twenty constraints, four indexes, the
-- policy and the two triggers, then the template guard function this file created. It runs first,
-- because the schedule points at an invoice and an invoice rollback would otherwise be blocked.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.recurring_schedules;

drop function if exists public.recurring_schedules_guard_template();

commit;
