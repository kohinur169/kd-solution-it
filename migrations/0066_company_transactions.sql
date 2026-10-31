-- path: migrations/0066_company_transactions.sql
-- STEP 032 - the company accounting rows of section 26: one row per income or expense of the
-- platform company.
--
-- Section 26 gives the platform company its own accounting area for company income and expenses,
-- reachable by `super_admin`, `ceo` and `finance_ops` only. This table is the single book those
-- screens read and write: every row is one movement, in minor units, on the day it happened,
-- with the person who recorded it.
--
-- The direction and the category are one decision, not two: an `income` row may only carry an
-- income category and an `expense` row an expense one, so a report that groups by category
-- cannot be steered by a category from the other side. The tax is bounded by the amount, because
-- section 26 asks for tax calculation inside the book and a tax larger than the movement is
-- arithmetic that lost its way.
--
-- A company transaction is never deleted. A mistake is corrected by a reversing entry, which is
-- what an accountant does and what an auditor expects, so `company_transactions_guard_state`
-- freezes the direction, the category, both amounts, the currency, the date and the source, and
-- refuses a soft delete with that sentence. The report of STEP 243 reads this table directly.

begin;

create function public.company_transactions_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.direction is distinct from old.direction
       or new.category is distinct from old.category
       or new.amount_minor is distinct from old.amount_minor
       or new.tax_minor is distinct from old.tax_minor
       or new.currency is distinct from old.currency
       or new.occurred_on is distinct from old.occurred_on
       or new.source is distinct from old.source then
      raise exception 'a company transaction keeps its direction, its amounts and its date'
        using errcode = 'check_violation';
    end if;

    if new.deleted_at is not null then
      raise exception 'a company transaction is corrected by a reversing entry, never deleted'
        using errcode = 'check_violation';
    end if;

    if new.recorded_by is distinct from old.recorded_by then
      raise exception 'a company transaction keeps the person who recorded it'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.company_transactions_guard_state() is
  'Freezes the direction, the amounts and the date of a company movement, and refuses a delete.';

create table public.company_transactions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  direction text not null,
  category text not null,
  amount_minor bigint not null,
  tax_minor bigint not null default 0,
  currency text not null default 'USD',
  occurred_on date not null,
  source text not null default 'manual',
  description text not null,
  reference text,
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint company_transactions_pkey primary key (id),
  constraint company_transactions_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint company_transactions_recorded_by_fkey foreign key (recorded_by)
    references public.users (id),
  constraint company_transactions_platform_check check (company_id is null),
  constraint company_transactions_direction_check check (direction in ('income', 'expense')),
  constraint company_transactions_category_check check (
    category in ('platform_fee', 'subscription', 'setup_fee', 'other_income', 'processor_bill',
                 'hosting', 'software', 'payroll', 'legal', 'marketing', 'tax', 'other_expense')
  ),
  constraint company_transactions_income_category_check check (
    direction <> 'income'
    or category in ('platform_fee', 'subscription', 'setup_fee', 'other_income')
  ),
  constraint company_transactions_expense_category_check check (
    direction <> 'expense'
    or category in ('processor_bill', 'hosting', 'software', 'payroll', 'legal', 'marketing',
                    'tax', 'other_expense')
  ),
  constraint company_transactions_amount_check check (amount_minor > 0),
  constraint company_transactions_tax_check check (
    tax_minor between 0 and amount_minor
  ),
  constraint company_transactions_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint company_transactions_source_check check (
    source in ('manual', 'subscription', 'processor_bill', 'adjustment')
  ),
  constraint company_transactions_description_check check (
    char_length(description) between 1 and 280
    and description = btrim(description)
  ),
  constraint company_transactions_reference_check check (
    reference is null
    or (
      char_length(reference) between 1 and 120
      and reference = btrim(reference)
    )
  ),
  constraint company_transactions_updated_check check (updated_at >= created_at),
  constraint company_transactions_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  ),
  constraint company_transactions_row_version_check check (version > 0)
);

comment on table public.company_transactions is
  'One income or expense of the platform company, as section 26 describes its accounting area.';

comment on column public.company_transactions.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.company_transactions.company_id is
  'Always null: the book belongs to the platform company, not to a merchant.';

comment on column public.company_transactions.direction is
  'income or expense, and the category must belong to that side.';

comment on column public.company_transactions.category is
  'The line of the book this movement belongs to, closed by the two direction checks.';

comment on column public.company_transactions.amount_minor is
  'The movement in the currency minor unit, always positive; the direction carries the sign.';

comment on column public.company_transactions.tax_minor is
  'The tax inside the movement, never larger than it.';

comment on column public.company_transactions.currency is
  'The three letter currency of the movement.';

comment on column public.company_transactions.occurred_on is
  'The day the movement happened, which the reports group by.';

comment on column public.company_transactions.source is
  'Where the row came from: a person, a subscription charge, a processor bill or a correction.';

comment on column public.company_transactions.description is
  'What the movement was, up to 280 characters.';

comment on column public.company_transactions.reference is
  'The invoice, statement or bill number the movement points at, when there is one.';

comment on column public.company_transactions.recorded_by is
  'The finance person who recorded the movement.';

comment on column public.company_transactions.created_at is
  'When the row was written.';

comment on column public.company_transactions.updated_at is
  'Set by the company_transactions_set_row_metadata trigger on every update.';

comment on column public.company_transactions.deleted_at is
  'Present for the schema rule; the guard refuses a value, because a reversal corrects a row.';

comment on column public.company_transactions.version is
  'Optimistic locking counter, incremented by the company_transactions_set_row_metadata trigger.';

-- The book by day, which the report screen reads newest first.
create index company_transactions_date_idx
  on public.company_transactions (occurred_on desc)
  where deleted_at is null;

-- One side of the book and one line of it, which is how the report groups.
create index company_transactions_category_idx
  on public.company_transactions (direction, category, occurred_on desc)
  where deleted_at is null;

create trigger company_transactions_guard_state
  before insert or update on public.company_transactions
  for each row
  execute function public.company_transactions_guard_state();

create trigger company_transactions_set_row_metadata
  before update on public.company_transactions
  for each row
  execute function public.set_row_metadata();

alter table public.company_transactions enable row level security;

create policy company_transactions_default_deny
  on public.company_transactions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
