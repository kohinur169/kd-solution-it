-- path: migrations/0113_invoice_discount_reresolve.down.sql
-- Rollback of 0113: restore `invoice_items_sync_totals` to the body `0023` gave it.
--
-- The forward file replaced the function rather than adding anything, so the rollback is the function as it
-- was: sum the live lines into the subtotal and leave the discount alone. That is safe to restore because
-- the columns `0112` added remain - a percentage discount still records its basis and its points - and the
-- only behaviour lost is the re-resolution, which returns the stored discount to the stale-after-a-change
-- behaviour every invoice had before this STEP.
--
-- This file creates no table and drops none, which is what the migrations gate expects of a rollback.

begin;

create or replace function public.invoice_items_sync_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target uuid;
  state text;
  lines_total bigint;
begin
  if tg_op = 'DELETE' then
    target := old.invoice_id;
  else
    target := new.invoice_id;
  end if;

  select status into state from public.invoices where id = target;

  if state is distinct from 'draft' then
    raise exception 'lines of an issued invoice are locked'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(line_total_minor), 0) into lines_total
  from public.invoice_items
  where invoice_id = target and deleted_at is null;

  update public.invoices set subtotal_minor = lines_total where id = target;

  return null;
end;
$$;

comment on function public.invoice_items_sync_totals() is
  'Recomputes the parent subtotal from the live lines and refuses line changes on an issued invoice.';

commit;
