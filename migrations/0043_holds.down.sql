-- path: migrations/0043_holds.down.sql
-- STEP 026 - rollback for 0043_holds.sql.
--
-- Drops the hold table and the three guards this file created. It runs before the settlement
-- rollback, because a hold may name a settlement.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.holds;

drop function if exists public.holds_guard_state();

drop function if exists public.holds_guard_amount();

drop function if exists public.holds_guard_owner();

commit;
