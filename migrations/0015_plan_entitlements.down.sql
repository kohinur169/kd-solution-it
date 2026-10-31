-- path: migrations/0015_plan_entitlements.down.sql
-- STEP 018 - rollback for 0015_plan_entitlements.sql.
--
-- Drops the entitlement table and everything it owns: seven constraints, three indexes, the policy
-- and the row metadata trigger. It runs before the plan rollback, because it references `plans`;
-- the plan table itself is dropped by its own file.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.plan_entitlements;

commit;
