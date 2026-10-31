-- path: migrations/0022_invoices.down.sql
-- STEP 021 - rollback for 0022_invoices.sql.
--
-- Drops the invoice table and everything it owns: twenty six constraints, six indexes, the policy and
-- the three triggers, then the two functions this file created. It must run after the event and item
-- rollbacks, because both reference this table.
--
-- No earlier table is touched: the invoice references `companies` and `clients`, it never owns them.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.invoices;

drop function if exists public.invoices_derive_total();
drop function if exists public.invoices_guard_paid();

commit;
