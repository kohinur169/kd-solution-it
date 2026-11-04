-- path: migrations/0114_invoice_numbering.sql
-- STEP 115 - a numbering service per merchant, so every merchant's invoices count in its own series.
--
-- Section 16 names "numbering" among the things an invoice does, and `0022` made a start at it: a draft
-- carries `number = null`, the number is assigned at issue, and `invoices_number_key` is unique on
-- `(company_id, number)` over the live rows so two invoices can never print the same number. What `0022`
-- deliberately left out is the counter - its own comment says "the counter itself lives in code" - and a
-- counter kept in code is the part that goes wrong: two requests read the same "next" value under the load
-- that happens the moment a merchant sends a batch, and one of them loses. This file is that counter.
--
-- ## Why a table and not a sequence
--
-- A Postgres `sequence` counts for the whole database, not per merchant, and it is not transactional: a
-- `nextval` is consumed even when the surrounding transaction rolls back, and a sequence cannot be told to
-- skip the numbers a merchant has already used or to start at a prefix the merchant chose. Section 20 makes
-- each sub-merchant a tenant that owns its own documents, so the counter has to be a row per company that
-- the take function can lock.
--
-- ## Why `invoice_number_counters` and not a settings table
--
-- The merchant-facing choices (`prefix`, `next_number`, `padding`, `yearly`, `reset_month`) are merchant
-- configuration and belong with the rest of their configuration; the counter that is actually consumed is a
-- different fact, it is written on every issue, and a table that is read constantly and rewritten constantly
-- should not be the table an operator edits by hand. They are two tables for that reason: one is read by the
-- settings screen and written on a click, the other is written by every issue.
--
-- ## The take function, and why it is the only way in
--
-- `take_invoice_number` is an `insert ... on conflict do update ... returning`, which is a single statement
-- that Postgres serialises on the row it touches. Two concurrent calls for one company cannot read the same
-- value: the second waits on the row lock the first took, and then increments what the first wrote. That is
-- the whole reason this exists rather than a `select` followed by an `update` in the service.
--
-- It also answers the **last number this merchant actually used**, so a merchant who sets `next_number` to a
-- value below what is already printed is caught rather than quietly reissuing a number that a client, a tax
-- authority and a court may already have seen. The comparison is on the numeric tail of the existing
-- numbers, not on the counter, because the counter can be reset and the printed numbers cannot.

begin;

create table public.invoice_number_settings (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  prefix text not null default 'INV',
  next_number bigint not null default 1,
  padding integer not null default 5,
  yearly boolean not null default false,
  reset_month integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_number_settings_pkey primary key (id),
  constraint invoice_number_settings_company_fkey foreign key (company_id)
    references public.companies (id),
  -- One series per merchant: the unique key is what `insert ... on conflict` infers.
  constraint invoice_number_settings_company_key unique (company_id),
  constraint invoice_number_settings_tenant_key unique (id, company_id),
  -- The prefix becomes the head of a printed number, so it may only be the characters `0022`'s number check
  -- already accepts, and it may not be empty: a number that starts with a separator prints badly.
  constraint invoice_number_settings_prefix_check check (
    prefix ~ '^[A-Z0-9][A-Z0-9._/-]{0,11}$'
  ),
  -- `bigint` so a merchant issuing past a billion is not a schema change, and positive because a zero or a
  -- negative next number cannot be printed.
  constraint invoice_number_settings_next_check check (next_number >= 1),
  -- Five is what most systems print; zero would print no counter at all, and a padding of eleven cannot fit
  -- inside `0022`'s forty character limit beside any prefix.
  constraint invoice_number_settings_padding_check check (padding between 1 and 11),
  -- A yearly reset needs a month; a monthly one is the yearly rule with January's answer.
  constraint invoice_number_settings_reset_check check (
    (yearly = false and reset_month is null)
    or (yearly = true and reset_month between 1 and 12)
  )
);

comment on table public.invoice_number_settings is
  'One invoice numbering series per merchant: the prefix, the next number, the padding and the reset rule.';

comment on column public.invoice_number_settings.next_number is
  'The number the next issue will take. Never lowered below a number the merchant has already printed.';

comment on column public.invoice_number_settings.reset_month is
  'The month the counter returns to next_number, when yearly is true. Null otherwise.';

create table public.invoice_number_counters (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  -- The year and month the series is counting inside, which is what a yearly reset moves. `0` is the
  -- unreset series, so one company has exactly one counter row and the unique key stays a single row.
  period_key integer not null default 0,
  last_number bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_number_counters_pkey primary key (id),
  constraint invoice_number_counters_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint invoice_number_counters_company_key unique (company_id),
  constraint invoice_number_counters_tenant_key unique (id, company_id),
  constraint invoice_number_counters_last_check check (last_number >= 0),
  constraint invoice_number_counters_period_check check (period_key >= 0)
);

comment on table public.invoice_number_counters is
  'The consumed counter of a merchant series. Written only by take_invoice_number, never by a caller.';

-- The settings row is read by the settings screen and by every issue, and both go through `company_id`,
-- which the unique constraint already indexes. The counter is the same. No further index is added.

create trigger invoice_number_settings_set_row_metadata
  before update on public.invoice_number_settings
  for each row
  execute function public.set_row_metadata();

create trigger invoice_number_counters_set_row_metadata
  before update on public.invoice_number_counters
  for each row
  execute function public.set_row_metadata();

alter table public.invoice_number_settings enable row level security;

create policy invoice_number_settings_default_deny
  on public.invoice_number_settings
  as permissive
  for all
  to public
  using (false)
  with check (false);

alter table public.invoice_number_counters enable row level security;

create policy invoice_number_counters_default_deny
  on public.invoice_number_counters
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The year a counter is counting in, as `YYYYMM` for a monthly reset and `YYYY` for a yearly one.
create function public.invoice_number_period(p_yearly boolean, p_reset_month integer, p_at timestamptz)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when not p_yearly then 0
    -- The series rolls over when the calendar reaches the reset month, so every month from then to the end
    -- of the year belongs to that year's series and the months before it still belong to the previous one.
    when extract(month from p_at) >= p_reset_month then extract(year from p_at)::integer
    else extract(year from p_at)::integer - 1
  end;
$$;

comment on function public.invoice_number_period(boolean, integer, timestamptz) is
  'The series period for an instant: 0 when the series never resets, otherwise the year the instant belongs to.';

-- The number a merchant's printed invoices have actually reached, for the "do not go backwards" check.
--
-- The tail is taken after the last separator of the prefix, because a prefix may itself contain digits and
-- the counter is the part after it. A row whose number does not end in digits - a hand-corrected invoice, a
-- number from another system - contributes nothing rather than a wrong maximum.
create function public.invoice_number_last_used(p_company_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(max((regexp_replace(number, '^.*[^0-9]', ''))::bigint), 0)
  from public.invoices
  where company_id = p_company_id
    and deleted_at is null
    and number ~ '[0-9]$';
$$;

comment on function public.invoice_number_last_used(uuid) is
  'The largest counter a merchant has already printed, read from the issued numbers rather than from the counter.';

create function public.take_invoice_number(
  p_company_id uuid,
  p_at timestamptz
)
returns table (
  number text,
  sequence_number bigint,
  period_key integer
)
language plpgsql
set search_path = ''
as $$
declare
  settings_row public.invoice_number_settings;
  period integer;
  taken bigint;
  printed text;
  last_used bigint;
  start_at bigint;
begin
  -- The series settings, or the defaults for a merchant who has never opened the screen. A missing row is not
  -- an error: the first issue of a new merchant has to work, and `INV` / 1 / padded to five is the answer.
  select * into settings_row
  from public.invoice_number_settings
  where company_id = p_company_id and deleted_at is null;

  if not found then
    settings_row.prefix := 'INV';
    settings_row.next_number := 1;
    settings_row.padding := 5;
    settings_row.yearly := false;
    settings_row.reset_month := null;
  end if;

  period := public.invoice_number_period(settings_row.yearly, settings_row.reset_month, p_at);

  -- Where a fresh counter starts.
  --
  -- Normally the merchant's `next_number`. But a merchant can already have printed numbers this counter never
  -- issued - a series imported from another system, a number an operator corrected by hand, an invoice issued
  -- before this table existed - and starting at one would either reissue one of them or, with the check below,
  -- refuse the merchant's first issue forever with no way out. So the start is clamped above the highest number
  -- they have actually printed, and the check below becomes a safety net rather than the only defence.
  --
  -- A `next_number` a human deliberately set too low is refused on the settings screen instead, where the
  -- merchant can be told which value is safe; this function is the wrong place to argue with a person.
  last_used := public.invoice_number_last_used(p_company_id);
  start_at := greatest(settings_row.next_number, last_used + 1);

  -- One statement takes the counter. `on conflict` is the serialisation point: a second caller waits on this
  -- row, and the case on the update is what implements the reset - a row from an earlier period restarts at
  -- `start_at` instead of continuing the old series.
  insert into public.invoice_number_counters as counter (company_id, period_key, last_number)
  values (p_company_id, period, start_at)
  on conflict (company_id) do update
    set last_number = case
          when counter.period_key = excluded.period_key then counter.last_number + 1
          else excluded.last_number
        end,
        period_key = excluded.period_key
  returning counter.last_number into taken;

  -- A number the merchant has already printed is never reissued. The counter can be edited on the settings
  -- screen and can be reset by time, so the counter alone is not evidence; the printed numbers are.
  if taken <= last_used then
    raise exception 'invoice number % would be reused by this merchant', taken
      using errcode = 'check_violation';
  end if;

  printed := settings_row.prefix || '-' || lpad(taken::text, settings_row.padding, '0');

  -- `0022`'s own check, applied here so a settings row that cannot produce a printable number is refused at
  -- the take rather than at the insert of the invoice it was taken for. A number freed this way is consumed,
  -- which is deliberate: a gap in a merchant's series is evident, a duplicate is a legal problem.
  if char_length(printed) < 3 or char_length(printed) > 40 or printed !~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$' then
    raise exception 'invoice number % cannot be printed', printed
      using errcode = 'check_violation';
  end if;

  number := printed;
  sequence_number := taken;
  period_key := period;

  return next;
end;
$$;

comment on function public.take_invoice_number(uuid, timestamptz) is
  'Takes the next number of a merchant series atomically and prints it, refusing a number already used.';

commit;
