-- path: migrations/0016_pricing_versions.sql
-- STEP 018 - the public price list, versioned.
--
-- Section 14: "The public Pricing page shows the full detailed price list: platform fee, processor
-- fees, payout fees, chargeback fees and refund fees, and who pays each"; "A new price is announced
-- 30 days before it becomes effective. Every pricing version is kept with its effective date."
--
-- One row is one complete price list, not one fee. A price list is read as a whole by the invoice,
-- payment and settlement STEPs, and a merchant must never see a mixture of two lists, so the fees
-- live together behind one effective instant.
--
-- Percentages are basis points (0 to 10000), fixed amounts are minor units of the currency, and
-- every fee names its payer: merchant, platform or customer. Section 14 asks "who pays each", and a
-- single payer column for all five would answer a question nobody asked.
--
-- A price list has a scope. `scope_id` is generated from `company_id`: null means the platform list
-- that applies to everyone, and a merchant id means the override section 10 allows when a fee is set
-- "globally and per sub-merchant". The generated column makes the two uniqueness rules below work
-- for the platform scope, which a plain nullable column could not do.
--
-- The thirty day rule is a check, not a note: `effective_from` must be at least thirty days after
-- `announced_at` whenever the list has been announced. A list may be prepared privately, with no
-- announcement yet, and the rule begins exactly when the announcement exists.
--
-- `retired_at` ends a list and is checked to fall at or after its own effective instant. One
-- active window per scope is a writing rule: an exclusion constraint would need `btree_gist`, and
-- this folder does not create extensions.

begin;

create table public.pricing_versions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  scope_id uuid generated always as (
    coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored not null,
  revision bigint not null,
  currency text not null,
  platform_fee_bps integer not null default 0,
  platform_fee_payer text not null default 'merchant',
  processor_fee_bps integer not null default 0,
  processor_fee_fixed_minor bigint not null default 0,
  processor_fee_payer text not null default 'merchant',
  payout_fee_fixed_minor bigint not null default 0,
  payout_fee_payer text not null default 'merchant',
  chargeback_fee_fixed_minor bigint not null default 0,
  chargeback_fee_payer text not null default 'merchant',
  refund_fee_fixed_minor bigint not null default 0,
  refund_fee_payer text not null default 'merchant',
  announced_at timestamptz,
  effective_from timestamptz not null,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint pricing_versions_pkey primary key (id),
  constraint pricing_versions_company_fkey foreign key (company_id) references public.companies (id),
  constraint pricing_versions_revision_check check (revision > 0),
  constraint pricing_versions_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint pricing_versions_platform_fee_bps_check check (
    platform_fee_bps between 0 and 10000
  ),
  constraint pricing_versions_processor_fee_bps_check check (
    processor_fee_bps between 0 and 10000
  ),
  constraint pricing_versions_platform_fee_payer_check check (
    platform_fee_payer in ('merchant', 'platform', 'customer')
  ),
  constraint pricing_versions_processor_fee_payer_check check (
    processor_fee_payer in ('merchant', 'platform', 'customer')
  ),
  constraint pricing_versions_payout_fee_payer_check check (
    payout_fee_payer in ('merchant', 'platform', 'customer')
  ),
  constraint pricing_versions_chargeback_fee_payer_check check (
    chargeback_fee_payer in ('merchant', 'platform', 'customer')
  ),
  constraint pricing_versions_refund_fee_payer_check check (
    refund_fee_payer in ('merchant', 'platform', 'customer')
  ),
  constraint pricing_versions_processor_fee_fixed_check check (processor_fee_fixed_minor >= 0),
  constraint pricing_versions_payout_fee_fixed_check check (payout_fee_fixed_minor >= 0),
  constraint pricing_versions_chargeback_fee_fixed_check check (chargeback_fee_fixed_minor >= 0),
  constraint pricing_versions_refund_fee_fixed_check check (refund_fee_fixed_minor >= 0),
  constraint pricing_versions_announcement_check check (
    announced_at is null or effective_from >= announced_at + interval '30 days'
  ),
  constraint pricing_versions_retirement_check check (
    retired_at is null or retired_at >= effective_from
  ),
  constraint pricing_versions_version_positive_check check (version > 0),
  constraint pricing_versions_updated_after_creation_check check (updated_at >= created_at),
  constraint pricing_versions_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.pricing_versions is
  'One complete price list with its effective instant. Platform scope when company_id is null, merchant override otherwise.';

comment on column public.pricing_versions.company_id is
  'Null for the platform price list that applies to everyone, otherwise the merchant whose fees this overrides.';

comment on column public.pricing_versions.scope_id is
  'Generated: company_id, or the zero uuid for the platform scope. Both uniqueness rules use this column.';

comment on column public.pricing_versions.revision is
  'Position of this price list inside its scope, starting at 1 and never reused.';

comment on column public.pricing_versions.currency is
  'ISO 4217 code in three upper case letters. Every amount on the row is in this currency.';

comment on column public.pricing_versions.platform_fee_bps is
  'Platform fee in basis points of the payment, 0 to 10000.';

comment on column public.pricing_versions.platform_fee_payer is
  'Who pays the platform fee: merchant, platform or customer.';

comment on column public.pricing_versions.processor_fee_bps is
  'Processor percentage in basis points, 0 to 10000.';

comment on column public.pricing_versions.processor_fee_fixed_minor is
  'Processor fixed fee per transaction in minor units.';

comment on column public.pricing_versions.payout_fee_fixed_minor is
  'Fixed fee per payout in minor units, or zero.';

comment on column public.pricing_versions.chargeback_fee_fixed_minor is
  'Fixed fee per chargeback in minor units, or zero.';

comment on column public.pricing_versions.refund_fee_fixed_minor is
  'Fixed fee per refund in minor units, or zero.';

comment on column public.pricing_versions.announced_at is
  'When the price list was announced. When set, the effective instant must be at least thirty days later.';

comment on column public.pricing_versions.effective_from is
  'When this price list starts to apply. Unique inside its scope.';

comment on column public.pricing_versions.retired_at is
  'When this price list stopped applying, never before effective_from.';

-- One revision per scope, and one price list per effective instant inside a scope.
create unique index pricing_versions_revision_key
  on public.pricing_versions (scope_id, revision);

create unique index pricing_versions_effective_key
  on public.pricing_versions (scope_id, effective_from);

-- The price list in force: the newest effective row of the scope that has not been retired.
create index pricing_versions_current_idx
  on public.pricing_versions (scope_id, effective_from desc)
  where retired_at is null and deleted_at is null;

create trigger pricing_versions_set_row_metadata
  before update on public.pricing_versions
  for each row
  execute function public.set_row_metadata();

alter table public.pricing_versions enable row level security;

create policy pricing_versions_default_deny
  on public.pricing_versions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
