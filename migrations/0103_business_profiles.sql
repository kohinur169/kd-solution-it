-- path: migrations/0103_business_profiles.sql
-- STEP 080 - the business information every processor on this platform is sent, filled once.
--
-- Section 5 states the promise in one line: "Merchant sets business information once on the
-- platform. The same information is sent to every connected processor." The five adapters of
-- section 6 each ask for their own subset of the same facts - a legal name, what kind of entity the
-- business is, its registration number, its tax id, the website it sells through and what it sells -
-- so the platform stores those facts once, here, and each adapter STEP later reads the columns it
-- needs. That is the whole point of the table: one row, not five copies that disagree.
--
-- ## Why the row is a draft and not a submission
--
-- A merchant cannot produce a registration number and a tax id in one sitting, and a form that
-- refused to save a half filled profile is a form people fill in the wrong order and abandon. Every
-- column below is therefore nullable, `services/kyc/business-profile.ts` saves whatever is present,
-- and `completed_at` is stamped only when the fields every processor requires are all there. The
-- check constraint on `completed_at` is the same rule in the database: a row cannot claim to be
-- complete without the six facts, whatever a future caller does.
--
-- ## The fields, and where each one comes from
--
--   - `legal_name` - the registered name of the business (NMI merchant name, Stripe legal entity,
--     Rainforest legal name, Airwallex registered name, Payoneer payee name);
--   - `trading_name` - the name it trades under, when that differs, which every adapter sends only
--     when it exists;
--   - `business_type` - `individual` or `company`, the one question every adapter asks before it
--     asks anything else;
--   - `registration_number` - the company registration number Airwallex and Rainforest require;
--   - `tax_id` - the tax identifier Stripe, Rainforest, NMI and Payoneer ask for;
--   - `website` - the store or site the business sells through, which the acceptance adapters use
--     for the section 5 website review;
--   - `business_description` - what the business sells, in the merchant's words, which the
--     underwriting desk reads and NMI and Rainforest send with the sub-merchant.
--
-- The address and the contact person are section 5's *next* section (STEP 082) and the merchant
-- category code is STEP 081; this file deliberately does not guess their columns, because a column
-- added here would have to be corrected by that STEP's migration and this one is append-only.
--
-- ## One live row per company
--
-- `business_profiles_company_key` is partial on `deleted_at is null`, so a save updates the row a
-- merchant has and a soft deleted row frees the company again. `business_profiles_tenant_key` is the
-- `(id, company_id)` pair later tables point at, the same shape `kyc_submissions` uses.
--
-- ## Why the table is default-deny
--
-- These are a merchant's business facts, including a tax identifier. No browser role reads the table
-- directly: `services/kyc/business-profile.ts` reads and writes with the service role key after
-- taking the company from the actor's session, so the tenant filter is never the caller's to choose.

begin;

create table public.business_profiles (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  legal_name text,
  trading_name text,
  business_type text,
  registration_number text,
  tax_id text,
  website text,
  business_description text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint business_profiles_pkey primary key (id),
  constraint business_profiles_tenant_key unique (id, company_id),
  constraint business_profiles_company_fkey foreign key (company_id) references public.companies (id),
  constraint business_profiles_legal_name_check check (
    legal_name is null
    or (char_length(legal_name) between 2 and 120 and legal_name = btrim(legal_name))
  ),
  constraint business_profiles_trading_name_check check (
    trading_name is null
    or (char_length(trading_name) between 1 and 120 and trading_name = btrim(trading_name))
  ),
  constraint business_profiles_type_check check (
    business_type is null or business_type in ('individual', 'company')
  ),
  constraint business_profiles_registration_check check (
    registration_number is null
    or (char_length(registration_number) between 2 and 40
        and registration_number = btrim(registration_number))
  ),
  constraint business_profiles_tax_id_check check (
    tax_id is null
    or (char_length(tax_id) between 2 and 40 and tax_id = btrim(tax_id))
  ),
  constraint business_profiles_website_check check (
    website is null
    or (char_length(website) between 9 and 300 and website like 'https://%')
  ),
  constraint business_profiles_description_check check (
    business_description is null
    or (char_length(business_description) between 10 and 1000
        and business_description = btrim(business_description))
  ),
  constraint business_profiles_completed_check check (
    completed_at is null
    or (
      legal_name is not null
      and business_type is not null
      and registration_number is not null
      and tax_id is not null
      and website is not null
      and business_description is not null
    )
  ),
  constraint business_profiles_completed_instant_check check (
    completed_at is null or completed_at >= created_at
  ),
  constraint business_profiles_row_version_check check (version > 0),
  constraint business_profiles_updated_check check (updated_at >= created_at),
  constraint business_profiles_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.business_profiles is
  'The section 5 business facts one merchant company fills once, and every section 6 adapter is sent from.';

comment on column public.business_profiles.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.business_profiles.company_id is
  'The merchant company these facts belong to. One live row per company.';

comment on column public.business_profiles.legal_name is
  'The registered name of the business, 2 to 120 characters, trimmed. Every adapter sends it.';

comment on column public.business_profiles.trading_name is
  'The name the business trades under when it differs from the registered name. Optional for every adapter.';

comment on column public.business_profiles.business_type is
  'individual or company: the first question every section 6 adapter asks.';

comment on column public.business_profiles.registration_number is
  'The company registration number Airwallex and Rainforest require for a company.';

comment on column public.business_profiles.tax_id is
  'The tax identifier Stripe, Rainforest, NMI and Payoneer ask for.';

comment on column public.business_profiles.website is
  'The https site or store the business sells through, 9 to 300 characters, used by the section 5 website review.';

comment on column public.business_profiles.business_description is
  'What the business sells, in the merchant words, 10 to 1000 characters. Read by underwriting and sent with a sub-merchant.';

comment on column public.business_profiles.completed_at is
  'When every field the section 6 adapters require was present. Null while the profile is still a draft.';

comment on column public.business_profiles.version is
  'Optimistic locking counter. Incremented by the business_profiles_set_row_metadata trigger.';

comment on column public.business_profiles.deleted_at is
  'Soft delete marker. A business profile is a merchant record, so it is never physically removed here.';

-- One live row per company: a save updates the row the merchant has.
create unique index business_profiles_company_key
  on public.business_profiles (company_id)
  where deleted_at is null;

create trigger business_profiles_set_row_metadata
  before update on public.business_profiles
  for each row
  execute function public.set_row_metadata();

alter table public.business_profiles enable row level security;

create policy business_profiles_default_deny
  on public.business_profiles
  for all
  to public
  using (false)
  with check (false);

commit;
