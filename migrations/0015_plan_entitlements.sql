-- path: migrations/0015_plan_entitlements.sql
-- STEP 018 - which services a plan includes.
--
-- Section 9: a plan carries "which services each plan includes", and "services outside the plan are
-- not usable by that merchant". That sentence is a set, so it is modelled as a set: one row per
-- service a plan includes, unique per plan and service.
--
-- It is deliberately not a boolean column per service. A column would mean a migration every time
-- the catalogue gains a service, and six boolean columns would let the same service be described in
-- two places. Here, adding a service to a plan is one insert; removing it is a revocation that
-- keeps the history; "which plans include invoicing" is one indexed query.
--
-- `service` is a lower snake key, checked for shape only. The catalogue lives in code, exactly like
-- the permission keys of STEP 014, and section 9 names its first six entries: invoicing,
-- payment_links, recurring_invoices, public_api, store_connections and test_mode.

begin;

create table public.plan_entitlements (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  plan_id uuid not null,
  service text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint plan_entitlements_pkey primary key (id),
  constraint plan_entitlements_company_fkey foreign key (company_id) references public.companies (id),
  constraint plan_entitlements_plan_fkey foreign key (plan_id) references public.plans (id),
  constraint plan_entitlements_service_check check (
    service ~ '^[a-z][a-z0-9_]*$' and char_length(service) between 2 and 48
  ),
  constraint plan_entitlements_version_positive_check check (version > 0),
  constraint plan_entitlements_updated_after_creation_check check (updated_at >= created_at),
  constraint plan_entitlements_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.plan_entitlements is
  'One service included by one plan. Absence of a row means the plan does not include that service.';

comment on column public.plan_entitlements.company_id is
  'Null, following the platform owned plan. Kept because every table carries the tenant column.';

comment on column public.plan_entitlements.plan_id is
  'The plan that includes the service.';

comment on column public.plan_entitlements.service is
  'Lower snake service key such as invoicing or public_api. The catalogue lives in code.';

comment on column public.plan_entitlements.version is
  'Optimistic locking counter, moved by the row metadata trigger.';

-- A plan includes one service once while the row is live; a revoked row frees the pair again.
create unique index plan_entitlements_live_key
  on public.plan_entitlements (plan_id, service)
  where deleted_at is null;

-- "Which plans include invoicing", and the reverse listing for a plan's page.
create index plan_entitlements_service_idx
  on public.plan_entitlements (service, plan_id)
  where deleted_at is null;

create trigger plan_entitlements_set_row_metadata
  before update on public.plan_entitlements
  for each row
  execute function public.set_row_metadata();

alter table public.plan_entitlements enable row level security;

create policy plan_entitlements_default_deny
  on public.plan_entitlements
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
