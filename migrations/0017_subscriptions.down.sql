-- path: migrations/0017_subscriptions.down.sql
-- STEP 019 - rollback for 0017_subscriptions.sql.
--
-- Drops the subscription table and everything it owns: nineteen constraints, four indexes, the
-- policy and the row metadata trigger. It must run after the charge rollback, because the charge
-- table references this one; `plans` and `companies` stay untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.subscriptions;

commit;
