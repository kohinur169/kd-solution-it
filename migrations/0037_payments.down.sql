-- path: migrations/0037_payments.down.sql
-- STEP 024 - rollback for 0037_payments.sql.
--
-- Drops the payment table and everything it owns: thirty five constraints, seven indexes, the policy
-- and the two triggers, then the refund state guard function this file created. It runs after the
-- refund and dispute rollbacks, because both point at a payment.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.payments;

drop function if exists public.payments_guard_refund_state();

commit;
