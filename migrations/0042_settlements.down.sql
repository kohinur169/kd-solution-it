-- path: migrations/0042_settlements.down.sql
-- STEP 026 - rollback for 0042_settlements.sql.
--
-- Drops the batch table and the guard this file created. It runs after the holds rollback, because a
-- hold may name a settlement, and before the ledger rollback of 0041, which the settlement posts to
-- through the ledger's own source row.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.settlements;

drop function if exists public.settlements_guard_state();

commit;
