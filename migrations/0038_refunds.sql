-- path: migrations/0038_refunds.sql
-- STEP 024 - the refunds of section 19.
--
-- "Refund interface: request, approval and status tracking." A refund is therefore a document with a
-- lifecycle, not an edit of the payment: it is requested, a named person approves it, the processor
-- answers, and the status records which of those happened. `requested_by` is required, `approved_by`
-- and `decided_at` appear exactly when the approval happened, `succeeded` requires the processed
-- instant and the provider's own refund identifier, and `failed` requires its detail.
--
-- Two rules are enforced by the database rather than trusted to the service.
--
-- The first is the cap. `refunds_guard_amount` sums the live refunds of the payment - approved,
-- processing and succeeded - and refuses a row that would take the total above what was charged. It
-- also refuses a refund of a payment that was never captured and a refund in another currency, because
-- money that was not taken cannot be given back.
--
-- The second is the running total. `refunds_sync_payment` writes `refunded_minor` and the
-- `partially_refunded` or `refunded` status on the payment after every refund write, and the payment
-- guard refuses any other writer of those two columns. A merchant that refunds 20.00 of a 100.00
-- payment therefore sees 20.00 and `partially_refunded`, and a merchant that refunds the rest sees
-- `refunded`, without the service computing either.
--
-- Refunds are not deleted. A mistake is cancelled or failed with its reason, because section 19 audits
-- every action and the money already moved.

begin;

create function public.refunds_guard_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payment_amount bigint;
  payment_currency text;
  payment_status text;
  payment_company uuid;
  payment_platform_fee bigint;
  live_total bigint;
begin
  select amount_minor, currency, status, company_id, platform_fee_minor
    into payment_amount, payment_currency, payment_status, payment_company, payment_platform_fee
  from public.payments where id = new.payment_id;

  if payment_company is null then
    raise exception 'a refund names a payment that exists'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from payment_company then
    raise exception 'a refund belongs to the merchant of its payment'
      using errcode = 'check_violation';
  end if;

  if new.currency is distinct from payment_currency then
    raise exception 'a refund is in the currency of its payment'
      using errcode = 'check_violation';
  end if;

  if new.status in ('requested', 'approved', 'processing', 'succeeded')
     and payment_status not in ('captured', 'settled', 'partially_refunded', 'refunded') then
    raise exception 'a refund needs a captured payment'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_minor), 0) into live_total
  from public.refunds
  where payment_id = new.payment_id
    and id is distinct from new.id
    and status in ('approved', 'processing', 'succeeded');

  if new.status in ('approved', 'processing', 'succeeded')
     and live_total + new.amount_minor > payment_amount then
    raise exception 'a refund never exceeds the payment'
      using errcode = 'check_violation';
  end if;

  if new.platform_fee_returned_minor > payment_platform_fee then
    raise exception 'the platform fee returned is never more than the fee taken'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.refunds_guard_amount() is
  'Caps a refund against its payment and refuses a refund of money that was never captured.';

create function public.refunds_sync_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payment_id_value uuid;
  payment_amount bigint;
  refunded bigint;
begin
  payment_id_value := coalesce(new.payment_id, old.payment_id);

  select amount_minor into payment_amount from public.payments where id = payment_id_value;

  if payment_amount is null then
    return null;
  end if;

  select coalesce(sum(amount_minor), 0) into refunded
  from public.refunds
  where payment_id = payment_id_value and status = 'succeeded';

  if refunded = 0 then
    update public.payments set refunded_minor = 0 where id = payment_id_value;
  elsif refunded >= payment_amount then
    update public.payments
    set refunded_minor = payment_amount, status = 'refunded', refunded_at = now()
    where id = payment_id_value;
  else
    update public.payments
    set refunded_minor = refunded, status = 'partially_refunded', refunded_at = null
    where id = payment_id_value;
  end if;

  return null;
end;
$$;

comment on function public.refunds_sync_payment() is
  'Writes the refunded total and the refunded status of the payment, and nothing else may.';

create table public.refunds (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  payment_id uuid not null,
  amount_minor bigint not null,
  currency text not null default 'USD',
  status text not null default 'requested',
  reason text not null,
  requested_by uuid not null,
  approved_by uuid,
  decided_at timestamptz,
  processed_at timestamptz,
  provider_refund_id text,
  platform_fee_returned boolean not null default false,
  platform_fee_returned_minor bigint not null default 0,
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint refunds_pkey primary key (id),
  constraint refunds_company_fkey foreign key (company_id) references public.companies (id),
  constraint refunds_payment_fkey foreign key (payment_id) references public.payments (id),
  constraint refunds_requested_by_fkey foreign key (requested_by) references public.users (id),
  constraint refunds_approved_by_fkey foreign key (approved_by) references public.users (id),
  constraint refunds_amount_check check (amount_minor > 0),
  constraint refunds_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint refunds_status_check check (
    status in ('requested', 'approved', 'processing', 'succeeded', 'failed', 'cancelled')
  ),
  constraint refunds_reason_check check (
    char_length(reason) between 1 and 500 and reason = btrim(reason)
  ),
  constraint refunds_approval_check check (
    (status in ('approved', 'processing', 'succeeded', 'failed')
      and approved_by is not null
      and decided_at is not null)
    or (status in ('requested', 'cancelled') and approved_by is null and decided_at is null)
  ),
  constraint refunds_processed_check check (
    (status in ('succeeded', 'failed')) = (processed_at is not null)
  ),
  constraint refunds_provider_id_check check (
    provider_refund_id is null
    or (
      char_length(provider_refund_id) between 1 and 120
      and provider_refund_id = btrim(provider_refund_id)
    )
  ),
  constraint refunds_provider_required_check check (
    status <> 'succeeded' or provider_refund_id is not null
  ),
  constraint refunds_failure_check check (
    (status = 'failed') = (failure_detail is not null)
    and (
      failure_detail is null
      or (char_length(failure_detail) between 1 and 280
          and failure_detail = btrim(failure_detail))
    )
  ),
  constraint refunds_platform_fee_check check (
    platform_fee_returned_minor >= 0
    and (platform_fee_returned or platform_fee_returned_minor = 0)
  ),
  constraint refunds_row_version_check check (version > 0),
  constraint refunds_updated_check check (updated_at >= created_at),
  constraint refunds_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.refunds is
  'A refund of one payment: who asked, who approved, what the processor answered and how much.';

comment on column public.refunds.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.refunds.company_id is
  'The merchant of the payment. A refund never crosses a merchant boundary.';

comment on column public.refunds.payment_id is
  'The payment being refunded. The sum of the live refunds never exceeds it.';

comment on column public.refunds.amount_minor is
  'How much is returned, in minor units of the currency.';

comment on column public.refunds.currency is
  'Three upper case letters, always the currency of the payment.';

comment on column public.refunds.status is
  'requested, approved, processing, succeeded, failed or cancelled.';

comment on column public.refunds.reason is
  'Why the money goes back, 1 to 500 characters, trimmed.';

comment on column public.refunds.requested_by is
  'The staff member who asked for the refund.';

comment on column public.refunds.approved_by is
  'The staff member who approved it, present from the approval onwards.';

comment on column public.refunds.decided_at is
  'When the approval happened, present exactly with the approver.';

comment on column public.refunds.processed_at is
  'When the processor answered, present exactly on a succeeded or failed refund.';

comment on column public.refunds.provider_refund_id is
  'The identifier the processor gave the refund, required once it succeeded.';

comment on column public.refunds.platform_fee_returned is
  'Whether the platform fee went back with the refund, the section 18 setting of super_admin.';

comment on column public.refunds.platform_fee_returned_minor is
  'How much of the platform fee went back, never more than the fee the payment carried.';

comment on column public.refunds.failure_detail is
  'Why the processor refused, at most 280 characters, present exactly on a failed refund.';

comment on column public.refunds.created_at is
  'When the refund was requested.';

comment on column public.refunds.updated_at is
  'Set by the refunds_set_row_metadata trigger on every update.';

comment on column public.refunds.deleted_at is
  'Soft delete marker. A refund row is cancelled or failed, it is never removed.';

comment on column public.refunds.version is
  'Optimistic locking counter. Incremented by the refunds_set_row_metadata trigger.';

-- One row per processor refund, so a webhook that reports it twice finds one refund.
create unique index refunds_provider_refund_key
  on public.refunds (payment_id, provider_refund_id)
  where provider_refund_id is not null;

-- The payment screen: the refunds of one payment, newest first.
create index refunds_payment_idx
  on public.refunds (company_id, payment_id, created_at desc);

-- The approval queue of section 19: what still needs a person.
create index refunds_queue_idx
  on public.refunds (company_id, status, created_at)
  where status in ('requested', 'approved', 'processing') and deleted_at is null;

create trigger refunds_guard_amount
  before insert or update on public.refunds
  for each row
  execute function public.refunds_guard_amount();

create trigger refunds_sync_payment
  after insert or update or delete on public.refunds
  for each row
  execute function public.refunds_sync_payment();

create trigger refunds_set_row_metadata
  before update on public.refunds
  for each row
  execute function public.set_row_metadata();

alter table public.refunds enable row level security;

create policy refunds_default_deny
  on public.refunds
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
