-- path: migrations/0018_subscription_charges.down.sql
-- STEP 019 - rollback for 0018_subscription_charges.sql.
--
-- Drops the charge table and everything it owns: eighteen constraints, four indexes, the policy and
-- the row metadata trigger. It runs before the subscription rollback, because it references that
-- table; `companies` stays untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.subscription_charges;

commit;
