-- path: migrations/0014_plans.down.sql
-- STEP 018 - rollback for 0014_plans.sql.
--
-- Drops the plan catalogue and everything it owns: thirteen constraints, three indexes, the policy
-- and the row metadata trigger. It must run after the entitlement rollback, because that table
-- references this one, and it leaves the tables from earlier migrations untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.plans;

commit;
