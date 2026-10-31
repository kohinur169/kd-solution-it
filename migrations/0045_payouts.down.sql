-- path: migrations/0045_payouts.down.sql
-- STEP 026 - rollback for 0045_payouts.sql.
--
-- Drops the payout table and the guard this file created. It runs first, because no later table points
-- at a payout: the ledger names one through its own source row and not through a foreign key.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.payouts;

drop function if exists public.payouts_guard_state();

commit;
