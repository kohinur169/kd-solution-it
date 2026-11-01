-- path: migrations/0039_disputes.down.sql
-- STEP 024 - rollback for 0039_disputes.sql.
--
-- Drops the dispute table and everything it owns: twenty constraints, four indexes, the policy and
-- the two triggers, then the deadline guard function this file created. It runs before the payment
-- rollback, because every dispute points at a payment.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.disputes;

drop function if exists public.disputes_guard_deadline();

commit;
