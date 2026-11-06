-- path: migrations/0121_invoice_tax_lines.down.sql
-- Rollback of 0121: removes the tax line table, the payment's tax column and the two keys that were
-- added to let the line reference its invoice item.
--
-- ## What comes back
--
-- The forward file creates one table with its two indexes, its guard function and trigger, its row
-- metadata trigger and its default-deny policy; adds `payments.tax_minor` with its check, its comment
-- and its guard; and adds the `(id, company_id)` unique on `invoice_items` so a composite foreign key
-- could point at it. Every one of those is removed here, and nothing else: `invoices.tax_minor`,
-- `invoice_items`' own columns and the `payments` money columns of `0037` are other files' rows and
-- stay exactly as they were.
--
-- ## What a rollback costs, stated rather than discovered
--
-- Dropping the table drops every stored breakdown. The invoice keeps its total in `invoices.tax_minor`,
-- which is not this file's column, so an invoice still says what was taxed; what is lost is the answer a
-- return needs - which lines and at what rate. The payments keep their amount, fee and refund columns;
-- only the collected tax column goes, so a settlement report loses its tax split and keeps its money.
-- Both facts are why this rollback is run last and never while a filing period is open, and why the
-- audit trail - which is append-only and outside every rollback - still holds the calculation that was
-- recorded.

begin;

drop trigger if exists payments_guard_tax_state on public.payments;

alter table public.payments
  drop constraint if exists payments_tax_check;

alter table public.payments drop column if exists tax_minor;

drop function if exists public.payments_guard_tax_state();

drop table if exists public.invoice_tax_lines;

drop function if exists public.invoice_tax_lines_guard_issued();

alter table public.invoice_items
  drop constraint if exists invoice_items_tenant_key;

commit;
