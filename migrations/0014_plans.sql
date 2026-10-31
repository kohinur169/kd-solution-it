-- path: migrations/0014_plans.sql
-- STEP 018 - the plan catalogue of section 9.
--
-- "super_admin creates plans: name, price, period and which services each plan includes." A plan is
-- therefore a platform object, not a tenant one: `company_id` is null on every row, and the column
-- exists because every table carries it and because a merchant specific plan would be a decision
-- rather than a schema change.
--
-- `code` is the stable identity. It is a lower case slug such as `starter` or `growth-yearly`, it is
-- unique for ever (a deleted plan keeps its code reserved), and it is what code branches on and
-- what an operator quotes. `name` is what a merchant reads.
--
-- Money is `price_minor bigint` with a three letter `currency`: never a float, never a formatted
-- string. `period` is a closed vocabulary of two values, because the billing STEP of section 12
-- needs to know exactly what a period means and "every 30 days" is a different thing from "monthly".
--
-- A plan is a draft until `published_at` is set, moves to `active` when it may be bought and to
-- `retired` when it may no longer be. A retired plan is kept: the subscriptions that reference it
-- must stay explainable, which is also why nothing here is ever deleted in a forward migration.
--
-- The services themselves are not columns. They are rows in `plan_entitlements`, so adding a
-- service to a plan is data rather than a migration.

begin;

create table public.plans (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  code text not null,
  name text not null,
  price_minor bigint not null,
  currency text not null,
  period text not null,
  status text not null default 'draft',
  published_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint plans_pkey primary key (id),
  constraint plans_company_fkey foreign key (company_id) references public.companies (id),
  constraint plans_code_check check (
    code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(code) between 2 and 39
  ),
  constraint plans_name_check check (
    char_length(name) between 1 and 80 and name = btrim(name)
  ),
  constraint plans_price_check check (price_minor >= 0),
  constraint plans_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint plans_period_check check (period in ('monthly', 'yearly')),
  constraint plans_status_check check (status in ('draft', 'active', 'retired')),
  constraint plans_published_check check (published_at is null or published_at >= created_at),
  constraint plans_sort_order_check check (sort_order >= 0),
  constraint plans_version_positive_check check (version > 0),
  constraint plans_updated_after_creation_check check (updated_at >= created_at),
  constraint plans_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.plans is
  'The platform plan catalogue: name, price, billing period and status. Services live in plan_entitlements.';

comment on column public.plans.company_id is
  'Null on every plan, because section 9 gives plan creation to super_admin; kept for a future tenant plan.';

comment on column public.plans.code is
  'Stable lower case slug such as starter or growth-yearly. Unique for ever, never reused.';

comment on column public.plans.name is
  'What the merchant reads, trimmed, at most 80 characters.';

comment on column public.plans.price_minor is
  'Price in minor units of currency, never negative and never a float.';

comment on column public.plans.currency is
  'ISO 4217 code in three upper case letters.';

comment on column public.plans.period is
  'monthly or yearly. A closed vocabulary, because the billing STEP must know what a period means.';

comment on column public.plans.status is
  'draft until it may be bought, active while it may be, retired when it may no longer be.';

comment on column public.plans.published_at is
  'When the plan became visible, or null while it is a draft.';

comment on column public.plans.sort_order is
  'Display order on a plan comparison screen, never negative.';

-- One plan per code, for ever: a retired or removed plan keeps its code reserved.
create unique index plans_code_key on public.plans (code);

-- The plan comparison screen: live plans in display order.
create index plans_catalogue_idx on public.plans (status, sort_order)
  where deleted_at is null;

-- The subset a merchant may choose from.
create index plans_available_idx on public.plans (published_at)
  where status = 'active' and deleted_at is null;

create trigger plans_set_row_metadata
  before update on public.plans
  for each row
  execute function public.set_row_metadata();

alter table public.plans enable row level security;

create policy plans_default_deny
  on public.plans
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
