-- path: migrations/0107_merchant_transaction_limits.sql
-- STEP 091 - the per-merchant starting transaction limit, and the monthly usage it is measured
-- against. FEATURE_LIST section 5 line 62 gives the compliance team the "starting monthly
-- transaction limit for new merchants" as an underwriting criterion; `0106` stores that criterion on
-- the platform's one `underwriting_criteria` row. This file stores what it means for ONE merchant:
-- one row per company carrying the assigned `monthly_limit`, the calendar `month_key` the usage is
-- counted in, and `used_amount` for that month.
--
-- Four decisions shape this file:
--
--   1. One row per merchant, created lazily. A new merchant's limit row is created from the criteria
--      row the first time the merchant reads their limit (or the office sets it), not at signup,
--      because a merchant that never transacts never needs the row. The partial unique index on
--      `company_id` makes the second row for one company impossible, and the service turns that
--      unique violation into a re-read, so two concurrent first reads converge on one row.
--   2. The month is a calendar month key, not a timestamp window. `month_key` is `YYYY-MM` in UTC,
--      checked by the column, and the service rolls the row over when the key moves on: `used_amount`
--      resets to zero in the same conditional update that sets the new key, so usage can never leak
--      across months. The rollback of a month is never attempted.
--   3. The database also enforces the ceiling: `used_amount <= monthly_limit` is a check constraint,
--      so even a caller that skips the service cannot record more than the merchant's limit. The
--      service checks first and answers CONFLICT `monthly_limit_exceeded` with a clean rule name; the
--      constraint is the backstop, and PostgREST's integrity violation maps to VALIDATION_FAILED.
--   4. Money is numeric(18,4) with the same ceiling the `0106` criteria carry, so an office-set limit
--      can never exceed what the criteria column allows. Roles: the owner reads their own row
--      (tenant isolation), the four office roles read every row, and only compliance_kyc and
--      super_admin may write - raising or lowering one merchant's limit is underwriting work, and
--      the CEO's confirmation of large actions happens in the approvals flow, not here.
--
-- The guard freezes `company_id` and refuses every delete and soft delete: a limit history is kept by
-- the audit log, not by removed rows. No seed: rows are born from the `0106` criteria row, which is
-- itself seeded, and a seeded limit row here would invent a merchant that does not exist.

begin;

create function public.merchant_transaction_limits_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a merchant limit row is changed, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a merchant limit row is never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'a merchant limit row belongs to one merchant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.merchant_transaction_limits_guard_state() is
  'Freezes the merchant a limit row belongs to, and refuses every removal.';

create table public.merchant_transaction_limits (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  month_key text not null,
  monthly_limit numeric(18,4) not null,
  used_amount numeric(18,4) not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint merchant_transaction_limits_pkey primary key (id),
  constraint merchant_transaction_limits_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint merchant_transaction_limits_updated_by_fkey foreign key (updated_by)
    references public.users (id),
  constraint merchant_transaction_limits_month_key_check check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint merchant_transaction_limits_limit_check
    check (monthly_limit > 0 and monthly_limit <= 100000000),
  constraint merchant_transaction_limits_used_check check (used_amount >= 0 and used_amount <= monthly_limit),
  constraint merchant_transaction_limits_version_positive_check check (version > 0),
  constraint merchant_transaction_limits_updated_after_creation_check check (updated_at >= created_at),
  constraint merchant_transaction_limits_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.merchant_transaction_limits is
  'One row per merchant: the assigned monthly transaction limit and the usage counted in the current calendar month.';

comment on column public.merchant_transaction_limits.month_key is
  'The UTC calendar month the usage is counted in, YYYY-MM. Rolled over by the service, never back.';

comment on column public.merchant_transaction_limits.monthly_limit is
  'The monthly transaction limit assigned to this merchant, in USD numeric(18,4). New merchants start at the 0106 criteria value.';

comment on column public.merchant_transaction_limits.used_amount is
  'What the merchant has transacted in month_key, in USD numeric(18,4). Never above monthly_limit: the column check enforces it.';

-- One live limit row per merchant, so the lazy first read cannot create two.
create unique index merchant_transaction_limits_company_key
  on public.merchant_transaction_limits (company_id)
  where deleted_at is null;

create trigger merchant_transaction_limits_guard_state
  before insert or update or delete on public.merchant_transaction_limits
  for each row
  execute function public.merchant_transaction_limits_guard_state();

create trigger merchant_transaction_limits_set_row_metadata
  before update on public.merchant_transaction_limits
  for each row
  execute function public.set_row_metadata();

alter table public.merchant_transaction_limits enable row level security;

create policy merchant_transaction_limits_default_deny
  on public.merchant_transaction_limits
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The merchant reads their own limit; the company comes from the session claims, never from a parameter.
create policy merchant_transaction_limits_owner_read
  on public.merchant_transaction_limits
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

-- The office reads every merchant's limit, because underwriting watches the exposure.
create policy merchant_transaction_limits_office_read
  on public.merchant_transaction_limits
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('finance_ops')
    or public.current_actor_has_role('super_admin')
  );

-- Only the compliance desk and the super admin change a merchant's limit.
create policy merchant_transaction_limits_manage_all
  on public.merchant_transaction_limits
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

commit;
