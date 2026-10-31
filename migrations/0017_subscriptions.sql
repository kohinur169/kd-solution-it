-- path: migrations/0017_subscriptions.sql
-- STEP 019 - the platform subscription of section 12.
--
-- A subscription binds one merchant to one plan and owns the billing cycle. Section 12 describes the
-- whole story in one paragraph: the subscription is charged from the merchant balance first, then
-- from the saved card, warnings start seven days before the due date, services stop when both fail
-- and resume as soon as a payment succeeds. Each of those sentences is a column or a check here or
-- in `subscription_charges`.
--
-- The price is deliberately not copied onto this row. STEP 018 keeps price lists versioned and its
-- handoff says a running subscription reads the price list in force; what was actually charged is
-- recorded on the charge row, which is the number an invoice and a dispute need.
--
-- One merchant has one live subscription: the partial unique index on `company_id` makes two billing
-- paths impossible. A cancelled subscription stays as history, so a merchant can subscribe again
-- without losing the previous agreement.
--
-- The mandate quartet is section 12's: "saving a card requires an explicit future-charge consent
-- (mandate). Consent text, version, time and IP are recorded." All four are set together or not at
-- all, and the text is bounded. The STEP that stores card tokens will reference this consent rather
-- than invent a second one.
--
-- `warning_sent_at` may not be earlier than seven days before `current_period_end`, so the warning
-- that section 12 requires cannot be sent so early that it means nothing.

begin;

create table public.subscriptions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  plan_id uuid not null,
  status text not null default 'pending',
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  next_due_at timestamptz not null,
  activated_at timestamptz,
  warning_sent_at timestamptz,
  stopped_at timestamptz,
  resumed_at timestamptz,
  cancelled_at timestamptz,
  mandate_text text,
  mandate_version text,
  mandate_accepted_at timestamptz,
  mandate_ip inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint subscriptions_pkey primary key (id),
  constraint subscriptions_company_fkey foreign key (company_id) references public.companies (id),
  constraint subscriptions_plan_fkey foreign key (plan_id) references public.plans (id),
  constraint subscriptions_status_check check (
    status in ('pending', 'active', 'past_due', 'stopped', 'cancelled')
  ),
  constraint subscriptions_period_check check (current_period_end > current_period_start),
  constraint subscriptions_next_due_check check (next_due_at >= current_period_start),
  constraint subscriptions_activated_check check (
    activated_at is null or activated_at >= created_at
  ),
  constraint subscriptions_warning_check check (
    warning_sent_at is null or warning_sent_at >= current_period_end - interval '7 days'
  ),
  constraint subscriptions_stopped_check check (
    stopped_at is null or stopped_at >= created_at
  ),
  constraint subscriptions_resumed_check check (
    resumed_at is null or (stopped_at is not null and resumed_at >= stopped_at)
  ),
  constraint subscriptions_cancelled_check check (
    cancelled_at is null or cancelled_at >= created_at
  ),
  constraint subscriptions_status_cancelled_check check (
    (status = 'cancelled') = (cancelled_at is not null)
  ),
  constraint subscriptions_status_stopped_check check (
    status <> 'stopped' or stopped_at is not null
  ),
  constraint subscriptions_mandate_check check (
    (mandate_text is null) = (mandate_version is null)
    and (mandate_text is null) = (mandate_accepted_at is null)
    and (mandate_text is null) = (mandate_ip is null)
  ),
  constraint subscriptions_mandate_text_check check (
    mandate_text is null
    or (char_length(mandate_text) between 1 and 2000 and mandate_text = btrim(mandate_text))
  ),
  constraint subscriptions_mandate_version_check check (
    mandate_version is null or mandate_version ~ '^[a-z0-9][a-z0-9.-]{0,31}$'
  ),
  constraint subscriptions_version_positive_check check (version > 0),
  constraint subscriptions_updated_after_creation_check check (updated_at >= created_at),
  constraint subscriptions_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.subscriptions is
  'One merchant bound to one plan, with its billing cycle, its status and the card mandate of section 12.';

comment on column public.subscriptions.company_id is
  'The merchant being billed. One live subscription per company, enforced by a partial unique index.';

comment on column public.subscriptions.plan_id is
  'The plan purchased. The price itself is read from the price list in force, never copied here.';

comment on column public.subscriptions.status is
  'pending, active, past_due, stopped or cancelled. The story of section 12 in one column.';

comment on column public.subscriptions.current_period_start is
  'Start of the billing cycle that the next charge pays for.';

comment on column public.subscriptions.current_period_end is
  'End of the current cycle, which is also the due instant of the next charge.';

comment on column public.subscriptions.next_due_at is
  'When the next charge attempt is scheduled, never before the cycle starts.';

comment on column public.subscriptions.activated_at is
  'When the first successful charge activated the subscription. A historical instant, not a cycle fact.';

comment on column public.subscriptions.warning_sent_at is
  'When the seven day warning was sent. Never earlier than seven days before the due instant.';

comment on column public.subscriptions.stopped_at is
  'When services stopped because both the balance and the card failed.';

comment on column public.subscriptions.resumed_at is
  'When a successful payment restored the services after a stop.';

comment on column public.subscriptions.cancelled_at is
  'When the subscription ended. Set exactly when the status is cancelled.';

comment on column public.subscriptions.mandate_text is
  'The future charge consent text the merchant accepted, trimmed, at most 2000 characters.';

comment on column public.subscriptions.mandate_version is
  'Version label of the consent text, so a later wording does not rewrite what was accepted.';

comment on column public.subscriptions.mandate_accepted_at is
  'When the merchant accepted the future charge consent.';

comment on column public.subscriptions.mandate_ip is
  'Origin of the consent, recorded as section 12 requires.';

-- One live subscription per merchant; a cancelled one frees the company for a new agreement.
create unique index subscriptions_live_key
  on public.subscriptions (company_id)
  where cancelled_at is null and deleted_at is null;

-- The billing job: which live subscriptions are due.
create index subscriptions_due_idx
  on public.subscriptions (next_due_at)
  where status in ('active', 'past_due') and deleted_at is null;

-- The plan page: which merchants are on this plan.
create index subscriptions_plan_idx
  on public.subscriptions (plan_id)
  where deleted_at is null;

create trigger subscriptions_set_row_metadata
  before update on public.subscriptions
  for each row
  execute function public.set_row_metadata();

alter table public.subscriptions enable row level security;

create policy subscriptions_default_deny
  on public.subscriptions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
