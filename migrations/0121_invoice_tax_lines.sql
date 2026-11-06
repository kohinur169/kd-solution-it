-- path: migrations/0121_invoice_tax_lines.sql
-- The section 7 tax line, stored on the invoice's lines and on the payment that settles it.
--
-- Section 7 says four things this file makes true rather than promised: "the tax amount appears as its
-- own line on the invoice and is stored on invoice and payment records", and "collected sales tax
-- totals are visible per sub-merchant and platform wide". The invoice already carries the total in
-- `0022`'s `tax_minor` - one number, and the collector writes it - but a total with no parts cannot
-- answer the two questions a merchant and an auditor ask: which line was taxed and at what rate, and
-- what was actually collected rather than merely invoiced.
--
-- ## Why a table rather than a column
--
-- A tax is per line, because a United States rate depends on the destination and the item's TIC, so
-- two lines of one invoice can legitimately carry different rates. `invoice_items` cannot hold it:
-- `0023` is a shipped file whose line total is generated from the quantity, the unit price and the
-- discount, and a tax column there would make the line total disagree with `invoices_total_check`.
-- One row per line, in its own table, leaves both shipped rules exactly as they are: the invoice stays
-- `subtotal - discount + tax`, and this table explains the `tax`.
--
-- ## The two identities the table enforces
--
--   1. `tax_minor <= taxable_minor` - a rate above 100 percent is not a tax, it is a typo, and it is
--      refused here rather than discovered by a merchant's client.
--   2. one live row per line - `invoice_tax_lines_line_key` covers `(invoice_id, line_index)` where the
--      row is live, so a second calculation replaces rather than appends. A recalculation writes the
--      same lines again; a breakdown that accumulates two answers to one question would make a total
--      that no longer matches its parts.
--
-- ## Frozen once the invoice is issued
--
-- A draft's tax is a calculation, and a calculation may be recalculated. An invoice that has left
-- `draft` has been sent to a client and filed in a return: its tax is a fact, so
-- `invoice_tax_lines_guard_issued` refuses to move an amount, an index, a rate or a TIC, and refuses
-- to remove the row, once the invoice's status is anything but `draft`. The guard reads the invoice,
-- not a copy of its status, so nothing can go stale.
--
-- ## The payment's share
--
-- `payments.tax_minor` is the part of the invoice's tax that this payment collected. A payment settles
-- an amount, not necessarily the whole invoice, so the share is proportional and the final payment
-- takes the remainder, which is the rule the collector implements and the handoff states. The column
-- is bounded by the payment's own amount: a payment cannot collect more tax than it moved money for.
-- `payments_guard_tax_state` freezes it once the payment is settled or refunded, because a collected
-- tax that moves after the money settled is a return that no longer reconciles.
--
-- ## What is deliberately not here
--
-- No rate table, no jurisdiction table, no nexus table: TaxCloud answers the rate, and section 7 says
-- the platform builds no tax engine of its own. No credential and no connection reference either - the
-- tax line is a money fact, and the connection that produced it is recorded in the audit trail where
-- the rest of the TaxCloud evidence lives.

begin;

-- A composite foreign key needs a unique constraint on the pair, and `0023` carries only the primary
-- key and the position index. The pair is what keeps a line and its invoice in one merchant, so the
-- constraint is added here the way `0105` added the country unique for the profile's reference.
alter table public.invoice_items
  add constraint invoice_items_tenant_key unique (id, company_id);

create table public.invoice_tax_lines (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid not null,
  invoice_item_id uuid not null,
  line_index integer not null,
  tic integer,
  taxable_minor bigint not null,
  tax_minor bigint not null,
  rate_bp integer not null default 0,
  currency text not null default 'USD',
  provider_key text not null default 'taxcloud',
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_tax_lines_pkey primary key (id),
  constraint invoice_tax_lines_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint invoice_tax_lines_invoice_fkey foreign key (invoice_id, company_id)
    references public.invoices (id, company_id),
  constraint invoice_tax_lines_item_fkey foreign key (invoice_item_id, company_id)
    references public.invoice_items (id, company_id),
  constraint invoice_tax_lines_index_check check (line_index >= 0 and line_index <= 999),
  constraint invoice_tax_lines_tic_check check (tic is null or (tic >= 0 and tic <= 99999)),
  constraint invoice_tax_lines_taxable_check check (taxable_minor >= 0),
  constraint invoice_tax_lines_tax_check check (tax_minor >= 0 and tax_minor <= taxable_minor),
  constraint invoice_tax_lines_rate_check check (rate_bp >= 0 and rate_bp <= 10000),
  constraint invoice_tax_lines_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint invoice_tax_lines_provider_check check (provider_key in ('taxcloud')),
  constraint invoice_tax_lines_calculated_check check (calculated_at >= created_at),
  constraint invoice_tax_lines_row_version_check check (version > 0),
  constraint invoice_tax_lines_updated_check check (updated_at >= created_at),
  constraint invoice_tax_lines_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.invoice_tax_lines is
  'The section 7 tax of one invoice line, with the rate it was taxed at and the provider that answered.';

comment on column public.invoice_tax_lines.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.invoice_tax_lines.company_id is
  'The merchant whose invoice this tax belongs to. Carried so every read can be tenant scoped.';

comment on column public.invoice_tax_lines.invoice_id is
  'The invoice the tax line explains, paired with the company by a composite foreign key.';

comment on column public.invoice_tax_lines.invoice_item_id is
  'The invoice line this tax was calculated for. The pair with the company is the reference.';

comment on column public.invoice_tax_lines.line_index is
  'The line index TaxCloud was asked about, so the answer can be matched to the request.';

comment on column public.invoice_tax_lines.tic is
  'The Tax Classification Code the merchant assigned, or null when TaxCloud applied its documented default.';

comment on column public.invoice_tax_lines.taxable_minor is
  'The line net the tax was calculated on, in minor units: gross minus the line and invoice discounts.';

comment on column public.invoice_tax_lines.tax_minor is
  'The tax of this line in minor units. Never above the taxable amount, and the sum is invoices.tax_minor.';

comment on column public.invoice_tax_lines.rate_bp is
  'The documented rate in basis points, kept as information. Money is never derived from this column.';

comment on column public.invoice_tax_lines.currency is
  'The invoice currency. Section 7 collects United States tax, so this is USD today.';

comment on column public.invoice_tax_lines.provider_key is
  'The tax provider that answered. One at launch, and the column is a closed vocabulary.';

comment on column public.invoice_tax_lines.calculated_at is
  'When TaxCloud answered for this line. A recalculation while the invoice is a draft moves it.';

comment on column public.invoice_tax_lines.created_at is
  'When the row was first written.';

comment on column public.invoice_tax_lines.updated_at is
  'Set by the invoice_tax_lines_set_row_metadata trigger on every update.';

comment on column public.invoice_tax_lines.deleted_at is
  'Soft delete marker. A replaced row stays readable for the calculation it recorded.';

comment on column public.invoice_tax_lines.version is
  'Optimistic locking counter. Incremented by the invoice_tax_lines_set_row_metadata trigger.';

-- One live row per line: a recalculation replaces the breakdown instead of stacking a second answer on
-- top of the first, which would leave an invoice whose parts no longer add up to its tax.
create unique index invoice_tax_lines_line_key
  on public.invoice_tax_lines (invoice_id, line_index)
  where deleted_at is null;

-- The totals question: tax per merchant over a period, which is what section 7 asks to be visible.
create index invoice_tax_lines_company_idx
  on public.invoice_tax_lines (company_id, calculated_at desc)
  where deleted_at is null;

create function public.invoice_tax_lines_guard_issued()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  invoice_status text;
begin
  select invoices.status into invoice_status
    from public.invoices as invoices
   where invoices.id = old.invoice_id;

  if invoice_status is null or invoice_status <> 'draft' then
    if tg_op = 'DELETE' then
      raise exception 'the tax line of an issued invoice is a fact and cannot be removed'
        using errcode = 'check_violation';
    end if;

    if new.deleted_at is not null
       or new.tax_minor is distinct from old.tax_minor
       or new.taxable_minor is distinct from old.taxable_minor
       or new.rate_bp is distinct from old.rate_bp
       or new.tic is distinct from old.tic
       or new.line_index is distinct from old.line_index
       or new.invoice_item_id is distinct from old.invoice_item_id then
      raise exception 'the tax line of an issued invoice is a fact and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.invoice_tax_lines_guard_issued() is
  'Refuses to rewrite or remove the tax line of an invoice that has left draft.';

create trigger invoice_tax_lines_guard_issued
  before update or delete on public.invoice_tax_lines
  for each row
  execute function public.invoice_tax_lines_guard_issued();

create trigger invoice_tax_lines_set_row_metadata
  before update on public.invoice_tax_lines
  for each row
  execute function public.set_row_metadata();

alter table public.invoice_tax_lines enable row level security;

create policy invoice_tax_lines_default_deny
  on public.invoice_tax_lines
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The payment record's part of the invoice's tax. A payment settles an amount rather than a document,
-- so the share is proportional and bounded by what the payment moved.
alter table public.payments add column tax_minor bigint not null default 0;

alter table public.payments
  add constraint payments_tax_check check (tax_minor >= 0 and tax_minor <= amount_minor);

comment on column public.payments.tax_minor is
  'The part of the invoice tax this payment collected. Proportional, and the final payment takes the remainder.';

create function public.payments_guard_tax_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tax_minor is distinct from old.tax_minor
     and old.status in ('settled', 'partially_refunded', 'refunded') then
    raise exception 'the tax of a settled payment is collected money and cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.payments_guard_tax_state() is
  'Refuses to move the collected tax of a payment whose money has settled.';

create trigger payments_guard_tax_state
  before update on public.payments
  for each row
  execute function public.payments_guard_tax_state();

commit;
