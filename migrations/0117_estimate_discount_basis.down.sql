-- path: migrations/0117_estimate_discount_basis.down.sql
-- Rollback of 0117: restore `estimate_items_sync_totals` to the body `0026` gave it, then drop the three
-- constraints and the two discount-basis columns.
--
-- ## Why the function is restored first
--
-- The forward file's replacement reads `discount_basis` and `discount_percent_bp`. A plpgsql body is
-- resolved when it runs, not when it is created, so dropping the columns under a function that names them
-- would leave a trigger that fails on the next line change - a quote whose lines could no longer be edited
-- and whose error would name a column that no longer exists. Restoring the body `0026` wrote first means
-- every statement after it operates on a schema nothing still references, and the rollback can be stopped
-- halfway without leaving a function pointing at absent columns.
--
-- The rest of the order mirrors the forward file in reverse. The coherence check names both columns, so it
-- is dropped before either of them; the per-column checks are dropped with their columns and are named
-- first only so the rollback reads as the exact inverse of what 0117 added.
--
-- `discount_minor` is not touched. It predates this migration, is `0025`'s own column and is the money
-- every total is computed from, so a rollback returns the quote to flat-amount discounts only and leaves
-- every stored amount exactly as it was. A quote that recorded a percentage keeps the money that
-- percentage resolved to, which is the amount the client was asked to sign - the honest thing to keep.
--
-- This file creates no table and drops none, which is what the migrations gate expects of a rollback.

begin;

create or replace function public.estimate_items_sync_totals()
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
    target := old.estimate_id;
  else
    target := new.estimate_id;
  end if;

  select status into state from public.estimates where id = target;

  if state is distinct from 'draft' then
    raise exception 'lines of an issued estimate are locked'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(line_total_minor), 0) into lines_total
  from public.estimate_items
  where estimate_id = target and deleted_at is null;

  update public.estimates set subtotal_minor = lines_total where id = target;

  return null;
end;
$$;

comment on function public.estimate_items_sync_totals() is
  'Recomputes the quote subtotal from the live lines and refuses line changes on an issued quote.';

alter table public.estimates
  drop constraint if exists estimates_discount_basis_coherent_check;

alter table public.estimates
  drop constraint if exists estimates_discount_percent_check;

alter table public.estimates
  drop constraint if exists estimates_discount_basis_check;

alter table public.estimates
  drop column if exists discount_percent_bp;

alter table public.estimates
  drop column if exists discount_basis;

commit;
