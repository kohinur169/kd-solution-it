-- path: migrations/0052_policy_acceptances.down.sql
-- STEP 028 - rollback for 0052_policy_acceptances.sql.
--
-- Drops the acceptance table with its constraints, indexes, policy and two triggers, then the guard
-- this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.policy_acceptances;

drop function if exists public.policy_acceptances_guard_state();

commit;
