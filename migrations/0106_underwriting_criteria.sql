-- path: migrations/0106_underwriting_criteria.sql
-- STEP 090 - the underwriting criteria the compliance team sets, of FEATURE_LIST section 5 line
-- "Underwriting criteria are set by the compliance team: starting monthly transaction limit for
-- new merchants, MCC based risk tiers with extra reserve or longer hold, required bank statement
-- period, and holding unusually large transactions for review."
--
-- Four decisions shape this file:
--
--   1. The global criteria are ONE row, not a registry of keys. `0080` made `platform_settings` a
--      key/value registry because its rows are switches an operator rotates one at a time; the
--      underwriting criteria are four fields of one policy that change together under one audit
--      entry, so they are columns of one singleton row. The guard trigger refuses a second live
--      row, a delete and a soft delete, exactly as `0080`'s guard freezes what identifies a
--      setting. `company_id` exists because every table carries it and is checked null: the
--      criteria belong to the platform, not to a merchant.
--   2. The MCC based risk tier itself already exists: `0077` gave every `mcc_codes` row a
--      `risk_tier` column that only `compliance_kyc` and `super_admin` may set. What was missing
--      is what a tier COSTS, so this file adds `underwriting_risk_tiers`: one row per tier
--      (low, medium, high) carrying the extra reserve percentage and the longer settlement hold
--      in days. "Extra reserve or longer hold" is therefore data the compliance team edits, not a
--      code path.
--   3. Money is numeric(18,4) like every other money column, with a positive check and a ceiling
--      (a starting limit above 100 million or a hold threshold above 1 billion USD is a typo, not
--      a policy). The statement period is months, the reserve a percent, the hold days - each with
--      the range its column check names.
--   4. The roles follow section 2 and section 5: `compliance_kyc` works the criteria and
--      `super_admin` keeps full control, so both may write both tables; `ceo` and `finance_ops`
--      read them, because the CEO decides pricing with the super admin and finance runs the holds.
--      The merchant reads only the one criterion that governs their own upload - the required bank
--      statement period, which the documents screen shows and the upload route enforces - and
--      only through the service's merchant-safe summary, never the tiers or the hold threshold.
--      The underwriting screen also lists merchants by the code they carry, so this file adds one
--      select policy on `business_profiles` for the four office roles; the index that serves it is
--      `business_profiles_mcc_idx` of `0104`.
--
-- The seeds carry no audit entry: the platform chain begins with the bootstrap of `0079` and this
-- file runs before any person exists, same rule as the `0080` seed. The criteria start at a
-- 1,000 USD monthly starting limit, a three month required bank statement period (the default
-- `0048`-era validation already applied), and a hold on transactions above 10,000 USD; the tiers
-- start with no extra reserve and no extra hold, because assigning a cost to a tier is the
-- compliance team's decision, not the seed's.

begin;

create function public.underwriting_criteria_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the underwriting criteria are changed, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'the underwriting criteria are never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if new.company_id is distinct from old.company_id then
    raise exception 'the underwriting criteria belong to the platform'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if exists (select 1 from public.underwriting_criteria where deleted_at is null) then
      raise exception 'the underwriting criteria are one row, never two'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  return new;
end;
$$;

comment on function public.underwriting_criteria_guard_state() is
  'Keeps the criteria one live platform row; a value changes with a version bump, never by a second row.';

create function public.underwriting_risk_tiers_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a risk tier is changed, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a risk tier is never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' and (new.tier is distinct from old.tier or new.company_id is distinct from old.company_id) then
    raise exception 'a risk tier keeps its name and its platform scope'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.underwriting_risk_tiers_guard_state() is
  'Freezes the tier name and the platform scope of a tier row, and refuses every removal.';

create table public.underwriting_criteria (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  starting_monthly_limit numeric(18,4) not null,
  bank_statement_months integer not null,
  large_transaction_hold_enabled boolean not null default true,
  large_transaction_hold_threshold numeric(18,4) not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint underwriting_criteria_pkey primary key (id),
  constraint underwriting_criteria_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint underwriting_criteria_updated_by_fkey foreign key (updated_by)
    references public.users (id),
  constraint underwriting_criteria_platform_check check (company_id is null),
  constraint underwriting_criteria_starting_limit_check
    check (starting_monthly_limit > 0 and starting_monthly_limit <= 100000000),
  constraint underwriting_criteria_statement_months_check
    check (bank_statement_months between 1 and 36),
  constraint underwriting_criteria_hold_threshold_check
    check (large_transaction_hold_threshold > 0 and large_transaction_hold_threshold <= 1000000000),
  constraint underwriting_criteria_version_positive_check check (version > 0),
  constraint underwriting_criteria_updated_after_creation_check check (updated_at >= created_at),
  constraint underwriting_criteria_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.underwriting_criteria is
  'The one platform row of section 5 underwriting criteria, set by the compliance team.';

comment on column public.underwriting_criteria.starting_monthly_limit is
  'The monthly transaction limit a new merchant starts with, in USD numeric(18,4). STEP 091 enforces it.';

comment on column public.underwriting_criteria.bank_statement_months is
  'The bank statement period a merchant must upload, in months, 1 to 36.';

comment on column public.underwriting_criteria.large_transaction_hold_enabled is
  'Whether unusually large transactions are held for review.';

comment on column public.underwriting_criteria.large_transaction_hold_threshold is
  'The transaction amount at or above which the hold applies, in USD numeric(18,4).';

comment on column public.underwriting_criteria.updated_by is
  'The office user who last changed the criteria, or null for the seed of this file.';

create table public.underwriting_risk_tiers (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  tier text not null,
  extra_reserve_percent numeric(5,2) not null default 0,
  hold_days integer not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint underwriting_risk_tiers_pkey primary key (id),
  constraint underwriting_risk_tiers_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint underwriting_risk_tiers_updated_by_fkey foreign key (updated_by)
    references public.users (id),
  constraint underwriting_risk_tiers_platform_check check (company_id is null),
  constraint underwriting_risk_tiers_tier_check check (tier in ('low', 'medium', 'high')),
  constraint underwriting_risk_tiers_reserve_check
    check (extra_reserve_percent >= 0 and extra_reserve_percent <= 100),
  constraint underwriting_risk_tiers_hold_days_check check (hold_days between 0 and 90),
  constraint underwriting_risk_tiers_version_positive_check check (version > 0),
  constraint underwriting_risk_tiers_updated_after_creation_check check (updated_at >= created_at),
  constraint underwriting_risk_tiers_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.underwriting_risk_tiers is
  'What each MCC risk tier costs: the extra reserve percent and the longer settlement hold in days.';

comment on column public.underwriting_risk_tiers.tier is
  'The tier a `mcc_codes.risk_tier` can name: low, medium or high. Frozen after the seed.';

comment on column public.underwriting_risk_tiers.extra_reserve_percent is
  'The extra rolling reserve a merchant in this tier pays, 0 to 100 percent.';

comment on column public.underwriting_risk_tiers.hold_days is
  'The extra days a settlement of this tier is held, 0 to 90.';

-- One live row per tier, so a reader never has to choose between two answers for low.
create unique index underwriting_risk_tiers_tier_key
  on public.underwriting_risk_tiers (tier)
  where deleted_at is null;

create trigger underwriting_criteria_guard_state
  before insert or update or delete on public.underwriting_criteria
  for each row
  execute function public.underwriting_criteria_guard_state();

create trigger underwriting_criteria_set_row_metadata
  before update on public.underwriting_criteria
  for each row
  execute function public.set_row_metadata();

create trigger underwriting_risk_tiers_guard_state
  before insert or update or delete on public.underwriting_risk_tiers
  for each row
  execute function public.underwriting_risk_tiers_guard_state();

create trigger underwriting_risk_tiers_set_row_metadata
  before update on public.underwriting_risk_tiers
  for each row
  execute function public.set_row_metadata();

alter table public.underwriting_criteria enable row level security;

create policy underwriting_criteria_default_deny
  on public.underwriting_criteria
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- Section 5 gives the criteria to the compliance team; section 2 keeps full control with super_admin.
create policy underwriting_criteria_manage_all
  on public.underwriting_criteria
  as permissive
  for all
  to public
  using (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  )
  with check (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  );

create policy underwriting_criteria_office_read
  on public.underwriting_criteria
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('finance_ops')
  );

-- The merchant reads the one criterion that governs their own upload, through the service's
-- merchant-safe summary; the policy allows the read, the service decides which column is answered.
create policy underwriting_criteria_owner_read
  on public.underwriting_criteria
  as permissive
  for select
  to public
  using (public.current_actor_has_role('owner'));

alter table public.underwriting_risk_tiers enable row level security;

create policy underwriting_risk_tiers_default_deny
  on public.underwriting_risk_tiers
  as permissive
  for all
  to public
  using (false)
  with check (false);

create policy underwriting_risk_tiers_manage_all
  on public.underwriting_risk_tiers
  as permissive
  for all
  to public
  using (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  )
  with check (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  );

create policy underwriting_risk_tiers_office_read
  on public.underwriting_risk_tiers
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('finance_ops')
  );

-- The underwriting screen of STEP 090 lists merchants by the code their profile carries, served by
-- `business_profiles_mcc_idx` of 0104. The office roles read; no merchant policy exists here.
create policy business_profiles_underwriting_read
  on public.business_profiles
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('finance_ops')
    or public.current_actor_has_role('super_admin')
  );

-- The seed: one criteria row, three tier rows. No audit entry, per the rule of the 0080 seed.
insert into public.underwriting_criteria
  (starting_monthly_limit, bank_statement_months, large_transaction_hold_enabled, large_transaction_hold_threshold)
values
  (1000.0000, 3, true, 10000.0000);

insert into public.underwriting_risk_tiers (tier, extra_reserve_percent, hold_days) values
  ('low', 0.00, 0),
  ('medium', 0.00, 0),
  ('high', 0.00, 0);

commit;
