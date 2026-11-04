-- path: migrations/0113_invoice_discount_reresolve.sql
-- STEP 114 - a percentage discount is a share of the subtotal, so it follows the subtotal.
--
-- `0023` gave `invoice_items_sync_totals` one job: sum the live lines into `invoices.subtotal_minor`.
-- That was enough while a discount could only be a flat amount, because the amount does not depend on the
-- lines. `0112` added a basis, and a percentage does depend on them: ten percent of 312.50 is 31.25, and ten
-- percent of the 100.00 that remains after the merchant removes a line is 10.00. A stored 31.25 beside a
-- 100.00 subtotal is not a percentage discount any more, it is a stale amount that happens to be divisible
-- by ten - and the client is charged the stale one.
--
-- ## Why the trigger and not the service
--
-- The subtotal and the discount have to move together or a reader can see one without the other. A service
-- that recomputed the discount would need a second statement after the first, so between them the row holds
-- a subtotal it cannot justify; and every path that changes a line - add, edit, remove, reorder - would
-- have to remember to do it. The trigger already owns the subtotal and fires on all four, so resolving the
-- percentage in the same UPDATE makes the invariant true for every writer, including one added later.
--
-- ## Why the rounding is written here as well as in TypeScript
--
-- `round()` on a `numeric` rounds half away from zero, which is the direction `grossLineMinor` and
-- `percentDiscountMinor` both use. The division is done in `numeric` rather than in integers so no
-- intermediate truncation can happen before the rounding decides, and the money columns stay `bigint`.
-- `lines_total::numeric * discount_percent_bp` cannot overflow, where the same product in `bigint` could.
--
-- ## What this file does not do
--
-- It does not touch a flat amount, does not touch an invoice that has left `draft` (it raises exactly as it
-- did), and does not add a column. `create or replace function` is the only way to change behaviour that an
-- earlier migration defined, since migrations are append-only and `0023` may never be edited.

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

  -- One statement moves the subtotal and, when the discount is a percentage, the money it is worth. A flat
  -- amount is left exactly as the merchant typed it, which is the whole difference between the two bases.
  -- `invoices_derive_total` then derives the total from the two values this statement has just made agree.
  update public.invoices
  set subtotal_minor = lines_total,
      discount_minor = case
        when discount_basis = 'percent'
          then round(lines_total::numeric * discount_percent_bp / 10000)::bigint
        else discount_minor
      end
  where id = target;

  return null;
end;
$$;

comment on function public.invoice_items_sync_totals() is
  'Recomputes the parent subtotal from the live lines, resolves a percentage discount against it, and refuses line changes on an issued invoice.';

commit;
