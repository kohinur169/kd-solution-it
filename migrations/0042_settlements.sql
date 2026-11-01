-- path: migrations/0042_settlements.sql
-- STEP 026 - the settlement batch of section 10 and the money the ledger posts for it.
--
-- A settlement is one processor batch for one merchant. It carries the window it covers, what it
-- collected and what it owes, all in minor units: gross, refunds, chargebacks, the processor fee,
-- the platform fee and the reserve withheld. `net_minor` is a generated column, so the batch can
-- never disagree with its parts, and a check states the same arithmetic for a reader of the catalog.
--
-- `net_minor` may be negative. Section 10 says a negative balance is covered first from the reserve,
-- so a batch whose chargebacks outgrew its payments is a real row and not an error; the check on the
-- parts keeps every part positive while the net is free to be below zero.
--
-- The hold is copied onto the row. `hold_days` arrives from the super_admin setting of section 10 and
-- `release_due_at` is computed from the window end, so changing the setting tomorrow does not move a
-- batch already in flight, exactly as STEP 016 kept a price version from rewriting an old price.
--
-- One batch is booked once: `(company_id, provider_settlement_id)` is unique, so a replayed provider
-- webhook cannot double the money. The status vocabulary is pending, in_transit, settled and failed,
-- each of the last three with its own instant, and a settled or failed batch is history that no
-- update may rewrite.

begin;

create function public.settlements_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.provider_settlement_id is distinct from old.provider_settlement_id
     or new.currency is distinct from old.currency
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.hold_days is distinct from old.hold_days
     or new.release_due_at is distinct from old.release_due_at then
    raise exception 'a settlement keeps its merchant, its batch, its window and its hold'
      using errcode = 'check_violation';
  end if;

  if old.status in ('settled', 'failed')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a settled or failed settlement is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.settlements_guard_state() is
  'Freezes the identity of a batch and locks it once settled or failed.';

create table public.settlements (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  provider_settlement_id text not null,
  currency text not null default 'USD',
  period_start timestamptz not null,
  period_end timestamptz not null,
  gross_minor bigint not null,
  refunds_minor bigint not null default 0,
  chargebacks_minor bigint not null default 0,
  processor_fee_minor bigint not null default 0,
  platform_fee_minor bigint not null default 0,
  reserve_minor bigint not null default 0,
  net_minor bigint generated always as
    (gross_minor - refunds_minor - chargebacks_minor - processor_fee_minor - platform_fee_minor
     - reserve_minor) stored,
  hold_days integer not null default 0,
  release_due_at timestamptz not null,
  status text not null default 'pending',
  settled_at timestamptz,
  failed_at timestamptz,
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint settlements_pkey primary key (id),
  constraint settlements_tenant_key unique (id, company_id),
  constraint settlements_company_fkey foreign key (company_id) references public.companies (id),
  constraint settlements_provider_check check (
    provider_settlement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$'
  ),
  constraint settlements_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint settlements_period_check check (period_end > period_start),
  constraint settlements_gross_check check (gross_minor > 0),
  constraint settlements_parts_check check (
    refunds_minor >= 0
    and chargebacks_minor >= 0
    and processor_fee_minor >= 0
    and platform_fee_minor >= 0
    and reserve_minor >= 0
  ),
  constraint settlements_net_check check (
    net_minor = gross_minor - refunds_minor - chargebacks_minor - processor_fee_minor
               - platform_fee_minor - reserve_minor
  ),
  constraint settlements_hold_check check (hold_days between 0 and 60),
  constraint settlements_release_check check (release_due_at >= period_end),
  constraint settlements_status_check check (
    status in ('pending', 'in_transit', 'settled', 'failed')
  ),
  constraint settlements_settled_instant_check check ((status = 'settled') = (settled_at is not null)),
  constraint settlements_failed_instant_check check ((status = 'failed') = (failed_at is not null)),
  constraint settlements_failure_check check (
    (failed_at is null or failure_detail is not null)
    and (
      failure_detail is null
      or (
        char_length(failure_detail) between 1 and 280
        and failure_detail = btrim(failure_detail)
      )
    )
  ),
  constraint settlements_row_version_check check (version > 0),
  constraint settlements_updated_check check (updated_at >= created_at),
  constraint settlements_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.settlements is
  'One processor settlement batch for one merchant, with the hold copied onto it.';

comment on column public.settlements.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.settlements.company_id is
  'The merchant the batch belongs to. Frozen after the row is written.';

comment on column public.settlements.provider_settlement_id is
  'The identifier the processor gave the batch. Unique per merchant, so a replay books nothing twice.';

comment on column public.settlements.currency is
  'Three upper case letters. Every amount on the row is in this currency.';

comment on column public.settlements.period_start is
  'The first instant of the window the batch covers.';

comment on column public.settlements.period_end is
  'The last instant of the window the batch covers. The release is counted forward from here.';

comment on column public.settlements.gross_minor is
  'What the processor collected for the merchant in the window, in minor units. Always positive.';

comment on column public.settlements.refunds_minor is
  'Refunds the processor took out of the batch.';

comment on column public.settlements.chargebacks_minor is
  'Chargebacks the processor took out of the batch.';

comment on column public.settlements.processor_fee_minor is
  'What the processor kept for itself in the window.';

comment on column public.settlements.platform_fee_minor is
  'What the platform charged the merchant for the window.';

comment on column public.settlements.reserve_minor is
  'What the rolling reserve of section 10 withheld from the batch.';

comment on column public.settlements.net_minor is
  'Gross minus the five deductions, generated. A negative net is covered from the reserve.';

comment on column public.settlements.hold_days is
  'The hold of section 10 in days, copied from the setting when the batch was booked.';

comment on column public.settlements.release_due_at is
  'The window end plus the hold: the instant the money becomes releasable.';

comment on column public.settlements.status is
  'pending, in_transit, settled or failed. The last two lock the row.';

comment on column public.settlements.settled_at is
  'Set exactly when the batch is settled.';

comment on column public.settlements.failed_at is
  'Set exactly when the batch failed.';

comment on column public.settlements.failure_detail is
  'Why the batch failed, at most 280 characters and trimmed. Required with a failed batch.';

comment on column public.settlements.created_at is
  'When the row was written.';

comment on column public.settlements.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.settlements.deleted_at is
  'Soft delete marker, set only while the batch is still pending or in transit.';

comment on column public.settlements.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One batch per merchant, whatever the processor replays.
create unique index settlements_provider_key
  on public.settlements (company_id, provider_settlement_id);

-- The release job of section 10: what is due, oldest first.
create index settlements_release_idx
  on public.settlements (company_id, release_due_at)
  where status in ('pending', 'in_transit') and deleted_at is null;

-- The merchant's batch list, newest window first.
create index settlements_page_idx
  on public.settlements (company_id, period_end desc)
  where deleted_at is null;

create trigger settlements_guard_state
  before update on public.settlements
  for each row
  execute function public.settlements_guard_state();

create trigger settlements_set_row_metadata
  before update on public.settlements
  for each row
  execute function public.set_row_metadata();

alter table public.settlements enable row level security;

create policy settlements_default_deny
  on public.settlements
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
