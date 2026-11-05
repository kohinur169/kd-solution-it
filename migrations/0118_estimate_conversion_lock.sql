-- path: migrations/0118_estimate_conversion_lock.sql
-- STEP 121 - an accepted estimate records the invoice it became.
--
-- `0025` reserved the column for exactly this. It declares `converted_invoice_id uuid` with
-- `estimates_invoice_fkey` pointing at `invoices (id)`, it states the pairing in two checks -
-- `estimates_conversion_check` ("converted_invoice_id is null or status = 'accepted'") and
-- `estimates_accepted_instant_check` - and it writes the intent in a comment: "the conversion, written
-- once". It even puts a unique partial index on the column so that two writers racing on one quote cannot
-- produce two invoices. Every one of those is the shape of a column that is meant to be filled.
--
-- ## Why the column could not be filled
--
-- `estimates_guard_terminal` is a BEFORE UPDATE trigger that refuses every change to a decided quote except
-- the metadata columns:
--
--   if old.status in ('accepted', 'void')
--      and (to_jsonb(new) - 'updated_at' - 'version')
--          is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
--     raise exception 'a decided estimate is locked' ...
--
-- `converted_invoice_id` is not in that exclusion list, so it is frozen by the same rule that freezes the
-- money, and the two constraints together leave no reachable state: `estimates_conversion_check` requires
-- the status to be `accepted` before the column may be non-null, and the guard forbids writing any column of
-- an accepted row. A conversion therefore cannot be recorded at all - not by a later STEP and not by STEP
-- 121, which is the STEP that exists to record it.
--
-- That is a defect in `0025`, not a decision in it: the comment beside the column says it is written once,
-- and the trigger prevents it from ever being written. This file repairs the guard in place rather than
-- rewriting `0025`, because a migration that has shipped is a record of what ran and this repository keeps
-- its migrations immutable once they are pushed.
--
-- ## What the new guard refuses
--
-- The exclusion is narrow on purpose. `converted_invoice_id` is added to the two metadata columns, so an
-- accepted quote is still frozen for every other purpose - the client name, the money, the memo, the
-- deadline, the signature facts - and an accepted or void quote still cannot be moved back to another
-- status. On top of that, three rules make "written once" true rather than merely permitted:
--
--   1. The new value may only be written on a row that is `accepted`; a void quote keeps the column frozen.
--   2. It may only be written while the old value is null, so a conversion can be recorded but never
--      replaced or cleared - an invoice cannot be detached from the quote that produced it.
--   3. It may only be written with a non-null value, so the write is always a conversion and never a clear.
--
-- Rule 2 is what closes the loophole that a bare exclusion would open: without it, adding the column to the
-- exclusion list would make `converted_invoice_id` the one field of a decided quote a caller could rewrite,
-- and a second request could point an accepted quote at a different invoice. With it, the first writer wins
-- and every later attempt raises, which is the same outcome the unique index already gives a race and the
-- same outcome a sequential retry deserves.
--
-- ## What is not changed
--
-- `estimates_accepted_instant_check`, `estimates_conversion_check` and the rest of `0025`'s constraints are
-- untouched, so a row still has to be accepted to hold an invoice and still has to have `accepted_at` to be
-- accepted. `estimates_invoice_key`, the unique partial index on the column where it is not null, is
-- untouched and is still the database's own answer to two conversions of one quote. `invoices` is not
-- touched: this STEP creates invoices through the service and never by changing the schema.
--
-- The body below is `0025`'s, with the exclusion list and the three new rules added. It is replaced with
-- `create or replace function`, which keeps the trigger binding, the search path and the comment intact.

begin;

create or replace function public.estimates_guard_terminal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('accepted', 'void') then
    -- The metadata columns are the trigger's own writes, so they are always allowed.
    if (to_jsonb(new) - 'updated_at' - 'version' - 'converted_invoice_id')
       is distinct from (to_jsonb(old) - 'updated_at' - 'version' - 'converted_invoice_id') then
      raise exception 'a decided estimate is locked'
        using errcode = 'check_violation';
    end if;

    -- The conversion is the one addition a decided quote accepts, and only once.
    if new.converted_invoice_id is distinct from old.converted_invoice_id then
      if old.status <> 'accepted' then
        raise exception 'a void estimate cannot be converted'
          using errcode = 'check_violation';
      end if;

      if old.converted_invoice_id is not null then
        raise exception 'an estimate is converted only once'
          using errcode = 'check_violation';
      end if;

      if new.converted_invoice_id is null then
        raise exception 'a conversion cannot be cleared'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.estimates_guard_terminal() is
  'Refuses every change to an accepted or void estimate except the metadata columns and the one write that records the invoice an accepted estimate became.';

commit;
