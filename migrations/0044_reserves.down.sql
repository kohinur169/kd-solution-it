-- path: migrations/0044_reserves.down.sql
-- STEP 026 - rollback for 0044_reserves.sql.
--
-- Drops the reserve table and the guard this file created. It runs after the payout rollback and
-- before the hold, settlement and ledger rollbacks: a settlement names the reserve it withheld from
-- only through the ledger, and no reserve points at a payout.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.reserves;

drop function if exists public.reserves_guard_state();

commit;
