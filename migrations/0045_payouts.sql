-- path: migrations/0045_payouts.sql
-- STEP 026 - the payout of section 10: money leaving the platform for the merchant's bank.
--
-- A payout is a request with a decision. Section 5 gives the release to finance_ops and asks the CEO
-- for a large amount, so the row names who requested it and who approved it, each with an instant, and
-- a payout cannot reach processing without approval. The status vocabulary is requested, approved,
-- processing, paid, failed and cancelled; paid, failed and cancelled are the end, and
-- `payouts_guard_state` freezes the row there.
--
-- Section 10 sets the minimum payout at 100 USD and pays anything below it as the accumulated
-- remainder after the hold period. That is two checks rather than a habit: an amount below 10000 minor
-- units is refused unless `is_remainder` is true, and `is_remainder` is refused on an amount that
-- already clears the floor.
--
-- A failed payout carries its code and its detail, because section 10 emails the merchant about it. A
-- paid payout must name its destination: the three snapshot columns are all present or all absent,
-- because STEP 027 owns the verified bank account table and the foreign key to it arrives there, and a
-- payout that left the platform without a destination on the row would be unauditable.
--
-- `net_minor` is generated from the amount and the payout fee, so what the merchant receives can never
-- disagree with what the row says it charged.

begin;

create function public.payouts_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.settlement_id is distinct from old.settlement_id
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.platform_fee_minor is distinct from old.platform_fee_minor
     or new.is_remainder is distinct from old.is_remainder
     or new.requested_by is distinct from old.requested_by then
    raise exception 'a payout keeps its merchant, its batch, its amount and its requester'
      using errcode = 'check_violation';
  end if;

  if old.status in ('paid', 'failed', 'cancelled')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a closed payout is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.payouts_guard_state() is
  'Freezes the identity of a payout and locks it once paid, failed or cancelled.';

create table public.payouts (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  settlement_id uuid,
  amount_minor bigint not null,
  currency text not null default 'USD',
  platform_fee_minor bigint not null default 0,
  net_minor bigint generated always as (amount_minor - platform_fee_minor) stored,
  status text not null default 'requested',
  requested_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  processing_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_detail text,
  provider_payout_id text,
  destination_bank_name text,
  destination_last_four text,
  destination_country text,
  is_remainder boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint payouts_pkey primary key (id),
  constraint payouts_company_fkey foreign key (company_id) references public.companies (id),
  constraint payouts_settlement_fkey foreign key (settlement_id, company_id)
    references public.settlements (id, company_id),
  constraint payouts_requested_by_fkey foreign key (requested_by) references public.users (id),
  constraint payouts_approved_by_fkey foreign key (approved_by) references public.users (id),
  constraint payouts_amount_check check (amount_minor > 0),
  constraint payouts_minimum_check check (amount_minor >= 10000 or is_remainder),
  constraint payouts_remainder_check check (not is_remainder or amount_minor < 10000),
  constraint payouts_fee_check check (
    platform_fee_minor >= 0 and platform_fee_minor < amount_minor
  ),
  constraint payouts_net_check check (net_minor = amount_minor - platform_fee_minor),
  constraint payouts_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payouts_status_check check (
    status in ('requested', 'approved', 'processing', 'paid', 'failed', 'cancelled')
  ),
  constraint payouts_approval_pair_check check ((approved_by is null) = (approved_at is null)),
  constraint payouts_approval_check check (
    status not in ('processing', 'paid') or approved_by is not null
  ),
  constraint payouts_processing_instant_check check (
    status <> 'processing' or processing_at is not null
  ),
  constraint payouts_paid_instant_check check ((status = 'paid') = (paid_at is not null)),
  constraint payouts_paid_processing_check check (status <> 'paid' or processing_at is not null),
  constraint payouts_failed_instant_check check ((status = 'failed') = (failed_at is not null)),
  constraint payouts_failure_check check (
    failed_at is null or (failure_code is not null and failure_detail is not null)
  ),
  constraint payouts_failure_code_check check (
    failure_code is null
    or (
      char_length(failure_code) between 2 and 64
      and failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    )
  ),
  constraint payouts_failure_detail_check check (
    failure_detail is null
    or (
      char_length(failure_detail) between 1 and 280
      and failure_detail = btrim(failure_detail)
    )
  ),
  constraint payouts_provider_check check (
    provider_payout_id is null
    or (
      char_length(provider_payout_id) between 3 and 120
      and provider_payout_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  ),
  constraint payouts_destination_pair_check check (
    (destination_bank_name is null) = (destination_last_four is null)
    and (destination_bank_name is null) = (destination_country is null)
  ),
  constraint payouts_destination_tail_check check (
    destination_last_four is null or destination_last_four ~ '^[A-Za-z0-9]{4}$'
  ),
  constraint payouts_destination_country_check check (
    destination_country is null or destination_country ~ '^[A-Z]{2}$'
  ),
  constraint payouts_paid_destination_check check (
    status <> 'paid' or destination_bank_name is not null
  ),
  constraint payouts_note_check check (
    note is null
    or (
      char_length(note) between 1 and 280
      and note = btrim(note)
    )
  ),
  constraint payouts_row_version_check check (version > 0),
  constraint payouts_updated_check check (updated_at >= created_at),
  constraint payouts_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.payouts is
  'One payout to the merchant bank, with its requester, its approver, its destination and its end.';

comment on column public.payouts.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.payouts.company_id is
  'The merchant the money leaves for. Frozen after the row is written.';

comment on column public.payouts.settlement_id is
  'The batch the payout releases, when it releases a named one.';

comment on column public.payouts.amount_minor is
  'How much leaves the platform, in minor units. At least 10000 unless it is the remainder.';

comment on column public.payouts.currency is
  'Three upper case letters. Every amount on the row is in this currency.';

comment on column public.payouts.platform_fee_minor is
  'The payout fee of section 14, kept below the amount so the net stays positive.';

comment on column public.payouts.net_minor is
  'The amount minus the payout fee, generated.';

comment on column public.payouts.status is
  'requested, approved, processing, paid, failed or cancelled. The last three lock the row.';

comment on column public.payouts.requested_by is
  'The person who requested the payout. Frozen after the row is written.';

comment on column public.payouts.approved_by is
  'The person who approved it, finance_ops or above. Required before processing.';

comment on column public.payouts.approved_at is
  'Set exactly when the payout was approved, together with the person.';

comment on column public.payouts.processing_at is
  'When the processor started the transfer. Required for processing and for a paid payout.';

comment on column public.payouts.paid_at is
  'Set exactly when the money left.';

comment on column public.payouts.failed_at is
  'Set exactly when the processor refused the transfer.';

comment on column public.payouts.failure_code is
  'The processor code of the failure, up to 64 characters.';

comment on column public.payouts.failure_detail is
  'What went wrong, at most 280 characters and trimmed, because section 10 emails it.';

comment on column public.payouts.provider_payout_id is
  'The processor identifier of the transfer. Unique per merchant, so a replay books nothing twice.';

comment on column public.payouts.destination_bank_name is
  'The bank the money went to, snapshotted. The verified account row arrives with STEP 027.';

comment on column public.payouts.destination_last_four is
  'The last four characters of the account, the only part of it this schema keeps.';

comment on column public.payouts.destination_country is
  'The two letter country of the destination bank.';

comment on column public.payouts.is_remainder is
  'True only for the accumulated remainder below the 100 USD minimum of section 10.';

comment on column public.payouts.note is
  'What the requester or the approver recorded, at most 280 characters and trimmed.';

comment on column public.payouts.created_at is
  'When the row was written.';

comment on column public.payouts.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.payouts.deleted_at is
  'Soft delete marker, refused once the payout has closed.';

comment on column public.payouts.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One transfer per merchant, whatever the processor replays.
create unique index payouts_provider_key
  on public.payouts (company_id, provider_payout_id)
  where provider_payout_id is not null;

-- What still needs a person: requested and approved payouts, oldest first.
create index payouts_queue_idx
  on public.payouts (company_id, created_at)
  where status in ('requested', 'approved') and deleted_at is null;

-- The merchant's payout list, newest first.
create index payouts_page_idx
  on public.payouts (company_id, created_at desc)
  where deleted_at is null;

create trigger payouts_guard_state
  before update on public.payouts
  for each row
  execute function public.payouts_guard_state();

create trigger payouts_set_row_metadata
  before update on public.payouts
  for each row
  execute function public.set_row_metadata();

alter table public.payouts enable row level security;

create policy payouts_default_deny
  on public.payouts
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
