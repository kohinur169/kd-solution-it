-- path: migrations/0112_invoice_discount_basis.down.sql
-- Rollback of 0112: drop the three constraints and the two discount-basis columns.
--
-- The order mirrors the forward file. The coherence check names both columns, so it is dropped before
-- either of them; the per-column checks are dropped with their columns and are named first only so the
-- rollback reads as the exact inverse of what 0112 added.
--
-- `discount_minor` is not touched. It predates this migration and is the money every total is computed
-- from, so a rollback returns the schema to flat-amount discounts only and leaves the stored amounts
-- exactly as they were.

begin;

alter table public.invoices
  drop constraint if exists invoices_discount_basis_coherent_check;

alter table public.invoices
  drop constraint if exists invoices_discount_percent_check;

alter table public.invoices
  drop constraint if exists invoices_discount_basis_check;

alter table public.invoices
  drop column if exists discount_percent_bp;

alter table public.invoices
  drop column if exists discount_basis;

commit;
