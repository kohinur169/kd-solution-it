-- path: migrations/0117_estimate_discount_basis.sql
-- STEP 119 - how an estimate-level discount was expressed, as a basis and a percentage.
--
-- Section 16 puts the quote in the same family as the invoice: "Estimates and quotes exist", and "when an
-- estimate is accepted it converts automatically into an invoice". `0026` said the same thing about the
-- anatomy - "this table mirrors `invoice_items` exactly" - and `0025` derives the quote's total with the
-- invoice's own function, `public.invoices_derive_total()`, so the identity `total = subtotal - discount +
-- tax` is defined once in this schema rather than once per document.
--
-- The discount vocabulary is the one place the two documents had drifted apart. `0112` gave `invoices` a
-- basis and a percentage and `0113` made a percentage follow the subtotal; `estimates` was written by
-- `0025`, two STEPs earlier, and could only ever hold a flat amount. A merchant quoting ten percent off
-- would have had to do the arithmetic themselves on a document whose whole purpose is to state an offer,
-- and STEP 121's conversion would have had to invent a basis the quote never recorded. This file gives the
-- quote the two columns the invoice already has, with the same names, the same defaults and the same
-- checks, so one document family has one discount vocabulary.
--
-- The money stays where it was. `estimates.discount_minor` is the resolved amount and the only column
-- `estimates_total_check` and `estimates_discount_check` read, so the identity keeps holding on the row
-- itself and every existing query is unchanged. These two columns record the *instruction* that produced
-- it, and a percentage is stored in basis points - one hundredth of a percent, so twelve and a half
-- percent is 1250 - because integer hundredths are exact where a float percent is not (rule 2: money math
-- never passes through a float).
--
-- The backfill is a no-op by construction: every quote row that exists was written by a caller that could
-- only send a flat amount, which is exactly `basis = 'amount'` with no percentage, and those are the
-- defaults the two columns are created with. A row cannot be left saying percent with no percentage
-- recorded, because the default is the honest description of history.
--
-- ## Why the trigger is replaced in the same file
--
-- A basis without re-resolution is a stale amount. `0026` gave `estimate_items_sync_totals` one job: sum
-- the live lines into `estimates.subtotal_minor`. That was enough while a discount could only be flat,
-- because a flat amount does not depend on the lines. Ten percent of 312.50 is 31.25, and ten percent of
-- the 100.00 that remains after the merchant removes a line is 10.00; a stored 31.25 beside a 100.00
-- subtotal is not a percentage discount any more, it is a stale amount that happens to be divisible by
-- ten - and the client is asked to sign the stale one. The subtotal and the discount have to move together
-- or a reader sees one without the other, and the trigger already owns the subtotal and fires on add,
-- edit, remove and reorder, so resolving the percentage in the same UPDATE makes the invariant true for
-- every writer including one added later. `create or replace function` is the only way to change behaviour
-- an earlier migration defined, since migrations are append-only and `0026` may never be edited.
--
-- ## What this file does not do
--
-- It does not touch a flat amount, does not touch a quote that has left `draft` (the function raises
-- exactly as `0026` wrote it, because a quote a client is deciding on must not move under them), adds no
-- table and drops none, and changes no status. Acceptance and void stay frozen by `0025`'s
-- `estimates_guard_terminal`.
--
-- The two checks are deliberately narrow. A percentage of zero is not a percentage discount - it is no
-- discount, and saying so as `amount 0` keeps one representation for one fact. A percentage above 10000
-- basis points is more than the whole quote and cannot produce a billable total, so it is refused at the
-- column as well as at the parser: the database is the last line, not the first.

begin;

alter table public.estimates
  add column discount_basis text not null default 'amount';

alter table public.estimates
  add column discount_percent_bp integer not null default 0;

comment on column public.estimates.discount_basis is
  'How the estimate-level discount was expressed: a flat amount of money, or a percentage of the subtotal.';

comment on column public.estimates.discount_percent_bp is
  'The percentage in basis points, one hundredth of a percent, so 12.5 percent is 1250. Zero unless the basis is percent.';

alter table public.estimates
  add constraint estimates_discount_basis_check check (
    discount_basis in ('amount', 'percent')
  );

alter table public.estimates
  add constraint estimates_discount_percent_check check (
    discount_percent_bp >= 0 and discount_percent_bp <= 10000
  );

-- The two columns have to agree with each other, or a reader cannot tell which one to trust. A percentage
-- discount always carries a positive percentage, and a flat-amount discount never carries one at all.
alter table public.estimates
  add constraint estimates_discount_basis_coherent_check check (
    (discount_basis = 'percent' and discount_percent_bp > 0)
    or (discount_basis = 'amount' and discount_percent_bp = 0)
  );

-- A percentage is a share of the subtotal, so it is resolved in the same statement that writes the
-- subtotal. The rounding is `round()` on a `numeric`, which rounds half away from zero - the direction
-- `grossLineMinor` and `percentDiscountMinor` both use in TypeScript - and the division happens in
-- `numeric` so no intermediate truncation can occur before the rounding decides, while the money columns
-- stay `bigint`. `lines_total::numeric * discount_percent_bp` cannot overflow, where the same product in
-- `bigint` could.
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

  -- One statement moves the subtotal and, when the discount is a percentage, the money it is worth. A flat
  -- amount is left exactly as the merchant typed it, which is the whole difference between the two bases.
  -- `estimates_derive_total` then derives the total from the two values this statement has just made agree.
  update public.estimates
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

comment on function public.estimate_items_sync_totals() is
  'Recomputes the quote subtotal from the live lines, resolves a percentage discount against it, and refuses line changes on an issued quote.';

-- No index is added for the two new columns: a quote is read by its merchant and by id, and the discount
-- is resolved on every line change, so both are read with the row already being fetched by primary key.

commit;
