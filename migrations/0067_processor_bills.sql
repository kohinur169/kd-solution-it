-- path: migrations/0067_processor_bills.sql
-- STEP 032 - the processor bills of section 26: one row per provider statement for a period.
--
-- Section 26 asks for processor bill matching against the platform records. A bill is one
-- provider, one period and one amount; the matching fills `matched_minor` as the payments of that
-- period are tied to it, and `variance_minor` is a stored generated column over the two, so the
-- number a finance person reviews is the database's subtraction and not a screen's.
--
-- A bill is one per provider and period, which a unique key enforces: two statements for the same
-- month would each claim the same payments. `matched_minor` only rises, because the matching runs
-- forward over the period; a correction is the disputed state, which a person sets and the guard
-- allows to return to `matched` once the provider agrees.
--
-- The status walks `received` to `matched` or `disputed`, `disputed` to `matched`, and either to
-- `paid`. A bill is never deleted: it is a financial record that the reconciliation of STEP 243
-- reads, and the document it was read from is a `files` row of the `dispute_document` purpose
-- when a statement arrives as a file.

begin;

create function public.processor_bills_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.provider_id is distinct from old.provider_id
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.currency is distinct from old.currency
       or new.billed_minor is distinct from old.billed_minor then
      raise exception 'a processor bill keeps its provider, its period and its billed amount'
        using errcode = 'check_violation';
    end if;

    if new.matched_minor < old.matched_minor then
      raise exception 'a processor bill matches forward and never backwards'
        using errcode = 'check_violation';
    end if;

    if old.matched_at is not null and new.matched_at is distinct from old.matched_at then
      raise exception 'a processor bill match instant is recorded once'
        using errcode = 'check_violation';
    end if;

    if old.status is distinct from new.status and not (
      (old.status = 'received' and new.status in ('matched', 'disputed'))
      or (old.status = 'disputed' and new.status = 'matched')
      or (old.status in ('matched', 'disputed') and new.status = 'paid')
    ) then
      raise exception 'a processor bill walks from received to matched or disputed, and on to paid'
        using errcode = 'check_violation';
    end if;

    if new.deleted_at is not null then
      raise exception 'a processor bill is a financial record and is never deleted'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.processor_bills_guard_state() is
  'Freezes the provider, the period and the billed amount of a bill, and walks its matching.';

create table public.processor_bills (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  provider_id uuid not null,
  period_start date not null,
  period_end date not null,
  currency text not null default 'USD',
  billed_minor bigint not null,
  matched_minor bigint not null default 0,
  variance_minor bigint generated always as (billed_minor - matched_minor) stored,
  status text not null default 'received',
  note text,
  document_file_id uuid,
  matched_at timestamptz,
  matched_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint processor_bills_pkey primary key (id),
  constraint processor_bills_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint processor_bills_provider_fkey foreign key (provider_id)
    references public.payment_providers (id),
  constraint processor_bills_document_fkey foreign key (document_file_id)
    references public.files (id),
  constraint processor_bills_matched_by_fkey foreign key (matched_by)
    references public.users (id),
  constraint processor_bills_platform_check check (company_id is null),
  constraint processor_bills_period_check check (period_end >= period_start),
  constraint processor_bills_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint processor_bills_billed_check check (billed_minor >= 0),
  constraint processor_bills_matched_check check (matched_minor >= 0),
  constraint processor_bills_status_check check (
    status in ('received', 'matched', 'disputed', 'paid')
  ),
  constraint processor_bills_matched_pair_check check (
    (status in ('matched', 'paid')) = (matched_at is not null)
  ),
  constraint processor_bills_note_check check (
    note is null
    or (
      char_length(note) between 1 and 280
      and note = btrim(note)
    )
  ),
  constraint processor_bills_updated_check check (updated_at >= created_at),
  constraint processor_bills_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint processor_bills_row_version_check check (version > 0)
);

comment on table public.processor_bills is
  'One processor statement for one period, with the amount matched against the platform records.';

comment on column public.processor_bills.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.processor_bills.company_id is
  'Always null: the bill is between the platform and its processor, not a merchant row.';

comment on column public.processor_bills.provider_id is
  'The payment provider that issued the statement.';

comment on column public.processor_bills.period_start is
  'The first day the statement covers.';

comment on column public.processor_bills.period_end is
  'The last day the statement covers, never before the first.';

comment on column public.processor_bills.currency is
  'The three letter currency the statement is billed in.';

comment on column public.processor_bills.billed_minor is
  'What the processor billed for the period, in minor units, frozen once written.';

comment on column public.processor_bills.matched_minor is
  'How much of the bill the platform records already explain; only rises.';

comment on column public.processor_bills.variance_minor is
  'Stored generated difference between the bill and the match, which is what a person reviews.';

comment on column public.processor_bills.status is
  'received, matched, disputed or paid; the guard walks it forward only.';

comment on column public.processor_bills.note is
  'The matching or dispute note of the finance person, up to 280 characters.';

comment on column public.processor_bills.document_file_id is
  'The statement file when the provider sent one, a files row.';

comment on column public.processor_bills.matched_at is
  'When the bill was fully matched. Required by the matched and paid states.';

comment on column public.processor_bills.matched_by is
  'The finance person who completed the matching.';

comment on column public.processor_bills.created_at is
  'When the row was written.';

comment on column public.processor_bills.updated_at is
  'Set by the processor_bills_set_row_metadata trigger on every update.';

comment on column public.processor_bills.deleted_at is
  'Present for the schema rule; the guard refuses a value, because a bill is a financial record.';

comment on column public.processor_bills.version is
  'Optimistic locking counter, incremented by the processor_bills_set_row_metadata trigger.';

-- One statement per provider per period, so two rows cannot claim the same payments.
create unique index processor_bills_period_key
  on public.processor_bills (provider_id, period_start, period_end);

-- The matching queue: bills by status, the oldest period first.
create index processor_bills_status_idx
  on public.processor_bills (status, period_end)
  where deleted_at is null;

create trigger processor_bills_guard_state
  before insert or update on public.processor_bills
  for each row
  execute function public.processor_bills_guard_state();

create trigger processor_bills_set_row_metadata
  before update on public.processor_bills
  for each row
  execute function public.set_row_metadata();

alter table public.processor_bills enable row level security;

create policy processor_bills_default_deny
  on public.processor_bills
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
