-- path: migrations/0018_subscription_charges.sql
-- STEP 019 - every attempt to collect one subscription cycle.
--
-- Section 12: "Subscription is charged first from the merchant balance", then "when the balance is
-- empty, the saved card is charged", and "when balance and card charges both fail on the due date,
-- all services stop at once". This table is the record of each attempt, and it stores the split:
-- `balance_used_minor` plus `card_used_minor`. A successful attempt must add up to the amount
-- exactly, a pending or failed one must add up to zero, and that pair of checks is what makes
-- "balance first" visible in the data instead of only in a code path.
--
-- A retry is a new row, never an overwrite: `attempt_number` counts attempts inside one period and
-- the triple `(subscription_id, period_start, attempt_number)` is unique. A support conversation
-- about a failed billing needs the first attempt, not just the one that finally worked.
--
-- A failure carries a code from a small vocabulary and at most 280 characters of operator text.
-- A card number, a token or a provider payload never belongs here; the detail column is for a
-- sentence a person can read.
--
-- The amount and the currency are copied onto the row on purpose. The subscription reads the price
-- list in force, but a charge that has already happened must keep the number and the currency it was
-- taken in, even after the price list is retired.

begin;

create table public.subscription_charges (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  subscription_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  attempt_number integer not null default 1,
  amount_minor bigint not null,
  currency text not null,
  status text not null default 'pending',
  balance_used_minor bigint not null default 0,
  card_used_minor bigint not null default 0,
  failure_code text,
  failure_detail text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint subscription_charges_pkey primary key (id),
  constraint subscription_charges_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint subscription_charges_subscription_fkey foreign key (subscription_id)
    references public.subscriptions (id),
  constraint subscription_charges_period_check check (period_end > period_start),
  constraint subscription_charges_attempt_check check (attempt_number >= 1),
  constraint subscription_charges_amount_check check (amount_minor > 0),
  constraint subscription_charges_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint subscription_charges_status_check check (
    status in ('pending', 'succeeded', 'failed')
  ),
  constraint subscription_charges_balance_used_check check (balance_used_minor >= 0),
  constraint subscription_charges_card_used_check check (card_used_minor >= 0),
  constraint subscription_charges_split_check check (
    (status = 'succeeded') = (balance_used_minor + card_used_minor = amount_minor)
    and (status = 'succeeded' or balance_used_minor + card_used_minor = 0)
  ),
  constraint subscription_charges_failure_check check (
    (status = 'failed') = (failure_code is not null)
  ),
  constraint subscription_charges_failure_code_check check (
    failure_code is null
    or failure_code in (
      'insufficient_balance', 'card_declined', 'no_card', 'mandate_missing', 'provider_error'
    )
  ),
  constraint subscription_charges_failure_detail_check check (
    failure_detail is null or char_length(failure_detail) between 1 and 280
  ),
  constraint subscription_charges_completed_check check (
    (status = 'pending') = (completed_at is null)
  ),
  constraint subscription_charges_version_positive_check check (version > 0),
  constraint subscription_charges_updated_after_creation_check check (updated_at >= created_at),
  constraint subscription_charges_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.subscription_charges is
  'One collection attempt for one subscription cycle, with the balance and card split of section 12.';

comment on column public.subscription_charges.company_id is
  'The merchant being charged, kept denormalised so a billing query never needs the join.';

comment on column public.subscription_charges.subscription_id is
  'The subscription this attempt belongs to.';

comment on column public.subscription_charges.period_start is
  'Start of the cycle this attempt pays for, together with period_end it identifies the cycle.';

comment on column public.subscription_charges.period_end is
  'End of the cycle, which is also its due instant.';

comment on column public.subscription_charges.attempt_number is
  'Attempt inside this cycle, starting at 1. A retry is a new row, never an overwrite.';

comment on column public.subscription_charges.amount_minor is
  'Amount to collect in minor units, greater than zero.';

comment on column public.subscription_charges.currency is
  'Currency of this charge, copied so a retired price list cannot change what was taken.';

comment on column public.subscription_charges.status is
  'pending, succeeded or failed.';

comment on column public.subscription_charges.balance_used_minor is
  'How much of the amount the merchant balance covered, charged first as section 12 requires.';

comment on column public.subscription_charges.card_used_minor is
  'How much the saved card covered, the remainder after the balance.';

comment on column public.subscription_charges.failure_code is
  'Why the attempt failed, exactly when the status is failed.';

comment on column public.subscription_charges.failure_detail is
  'A sentence for the operator, at most 280 characters. Never a card number or a token.';

comment on column public.subscription_charges.completed_at is
  'When the attempt reached its outcome, null while it is pending.';

-- One attempt per cycle per number, so a retry cannot silently replace the previous attempt.
create unique index subscription_charges_attempt_key
  on public.subscription_charges (subscription_id, period_start, attempt_number);

-- The retry job: what is pending or failed, oldest first.
create index subscription_charges_retry_idx
  on public.subscription_charges (status, created_at)
  where deleted_at is null;

-- The merchant billing screen: every charge this company saw, most recent first.
create index subscription_charges_company_idx
  on public.subscription_charges (company_id, created_at desc)
  where deleted_at is null;

create trigger subscription_charges_set_row_metadata
  before update on public.subscription_charges
  for each row
  execute function public.set_row_metadata();

alter table public.subscription_charges enable row level security;

create policy subscription_charges_default_deny
  on public.subscription_charges
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
