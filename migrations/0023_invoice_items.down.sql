-- path: migrations/0023_invoice_items.down.sql
-- STEP 021 - rollback for 0023_invoice_items.sql.
--
-- Drops the line table and everything it owns: fifteen constraints, four indexes, the policy and the
-- three triggers, then the two functions this file created. It must run after the event rollback and
-- before the invoice rollback, because the lines point at an invoice.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.invoice_items;

drop function if exists public.invoice_items_guard_catalogue();
drop function if exists public.invoice_items_sync_totals();

commit;
