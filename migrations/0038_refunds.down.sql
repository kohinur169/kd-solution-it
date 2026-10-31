-- path: migrations/0038_refunds.down.sql
-- STEP 024 - rollback for 0038_refunds.sql.
--
-- Drops the refund table and everything it owns: eighteen constraints, four indexes, the policy and
-- the three triggers, then the cap guard and the payment sync functions this file created. It runs
-- before the payment rollback, because every refund points at a payment.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.refunds;

drop function if exists public.refunds_guard_amount();

drop function if exists public.refunds_sync_payment();

commit;
