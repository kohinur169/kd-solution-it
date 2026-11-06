-- path: migrations/0118_estimate_conversion_lock.down.sql
-- Rollback of 0118: put `estimates_guard_terminal` back to the body `0025` gave it.
--
-- ## Why this is a function restore and nothing else
--
-- The forward file creates no table and adds no column, so there is nothing to drop and no constraint that
-- this file introduced. All it changed was the body of one trigger function, and the rollback is that body
-- again, character for character as `0025` wrote it. `create or replace` keeps the trigger binding and the
-- search path, so the quote's terminal guard is as frozen after this file as it was before the forward one.
--
-- ## What a rollback costs, stated rather than discovered
--
-- After this file, an accepted quote can no longer record the invoice it became, which is the state `0025`
-- shipped - a column that `estimates_conversion_check` and `estimates_invoice_key` were built for and that
-- no write could fill. Rows already converted keep their `converted_invoice_id`: dropping a constraint does
-- not rewrite them, and this file does not clear the column. An invoice that exists because of a conversion
-- therefore stays attached to its quote, and the guard simply refuses any further change - which is the
-- honest state for a rollback, because detaching a client's accepted offer from the invoice it became would
-- destroy evidence rather than undo a migration.

begin;

create or replace function public.estimates_guard_terminal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('accepted', 'void')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a decided estimate is locked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.estimates_guard_terminal() is
  'Refuses every change to an accepted or void estimate except the metadata columns.';

commit;
