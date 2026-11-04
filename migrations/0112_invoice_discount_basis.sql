-- path: migrations/0112_invoice_discount_basis.sql
-- STEP 114 - how an invoice-level discount was expressed, as a basis and a percentage.
--
-- Section 16: "Line items can be added, edited and ordered correctly. Full discount support." Until now
-- a discount could only be said as a flat amount of money, which means a merchant who quotes ten percent
-- off has to do the arithmetic themselves, and a draft whose lines change keeps a discount that no longer
-- matches what was agreed. A basis fixes that: `amount` says the money is the instruction, `percent` says
-- the price is.
--
-- The money stays where it was. `invoices.discount_minor` is the resolved amount and the only column
-- `invoices_total_check` and `invoices_discount_check` read, so the identity `total = subtotal - discount
-- + tax` keeps holding on the row itself and every existing query is unchanged. These two columns record
-- the *instruction* that produced it, and a percentage is stored in basis points - 1/100 of a percent, so
-- twelve and a half percent is 1250 - because integer hundredths are exact where a float percent is not
-- (rule 2: money math never passes through a float).
--
-- The backfill is a no-op by construction: every row that exists was written by a caller that sent a flat
-- amount, which is exactly `basis = 'amount'` with no percentage, and those are the defaults the two
-- columns are created with. A row therefore cannot be left in a state where the basis says percent and
-- no percentage was ever recorded, because the default is the honest description of history.
--
-- The two checks are deliberately narrow. A percentage of zero is not a percentage discount - it is no
-- discount, and saying so as `amount 0` keeps one representation for one fact. A percentage above 10000
-- basis points is more than the whole invoice and cannot produce a billable total, so it is refused at the
-- column as well as at the parser: the database is the last line, not the first.

begin;

alter table public.invoices
  add column discount_basis text not null default 'amount';

alter table public.invoices
  add column discount_percent_bp integer not null default 0;

comment on column public.invoices.discount_basis is
  'How the invoice-level discount was expressed: a flat amount of money, or a percentage of the subtotal.';

comment on column public.invoices.discount_percent_bp is
  'The percentage in basis points, one hundredth of a percent, so 12.5 percent is 1250. Zero unless the basis is percent.';

alter table public.invoices
  add constraint invoices_discount_basis_check check (
    discount_basis in ('amount', 'percent')
  );

alter table public.invoices
  add constraint invoices_discount_percent_check check (
    discount_percent_bp >= 0 and discount_percent_bp <= 10000
  );

-- The two columns have to agree with each other, or a reader cannot tell which one to trust. A percentage
-- discount always carries a positive percentage, and a flat-amount discount never carries one at all.
alter table public.invoices
  add constraint invoices_discount_basis_coherent_check check (
    (discount_basis = 'percent' and discount_percent_bp > 0)
    or (discount_basis = 'amount' and discount_percent_bp = 0)
  );

-- A row is read by its merchant and by id, and the discount is resolved on every line change, so the
-- subtotal is what the resolution multiplies. No index is added for the two new columns: they are read
-- with the row that is already being fetched by primary key.

commit;
