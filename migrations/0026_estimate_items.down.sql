-- path: migrations/0026_estimate_items.down.sql
-- STEP 022 - rollback for 0026_estimate_items.sql.
--
-- Drops the quote line table and everything it owns: fifteen constraints, four indexes, the policy
-- and the three triggers, then the two functions this file created. It must run before the quote
-- rollback, because the lines point at a quote.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.estimate_items;

drop function if exists public.estimate_items_guard_catalogue();
drop function if exists public.estimate_items_sync_totals();

commit;
