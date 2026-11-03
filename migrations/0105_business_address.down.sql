-- path: migrations/0105_business_address.down.sql
-- STEP 082 rollback of 0105: removes the address and contact columns from the business profile, the
-- completion instant, their constraints and the country index, and the unique constraint that let
-- the profile reference the country list. It touches nothing else.
--
-- Everything this file removes was created by `0105` and by nothing else. The tables of `0076`
-- (the 250 country rows), `0103` (the profiles) and `0104` (the category code) are other files'
-- rows and stay as they were. A rollback here means "the platform no longer stores a registered
-- address or contact person": the audit chain is append-only and outside every rollback, so every
-- save stays recorded even though the columns go, which is why this file is run last and never
-- while a merchant is waiting for an underwriting decision that reads the address.

begin;

drop index if exists public.business_profiles_country_idx;

alter table public.business_profiles
  drop constraint if exists business_profiles_address_completed_instant_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_address_completed_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_contact_phone_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_contact_email_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_contact_name_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_country_fkey;

alter table public.business_profiles
  drop constraint if exists business_profiles_country_code_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_postal_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_state_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_city_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_address_line2_check;

alter table public.business_profiles
  drop constraint if exists business_profiles_address_line1_check;

alter table public.business_profiles
  drop column if exists address_completed_at;

alter table public.business_profiles
  drop column if exists contact_phone;

alter table public.business_profiles
  drop column if exists contact_email;

alter table public.business_profiles
  drop column if exists contact_name;

alter table public.business_profiles
  drop column if exists country_code;

alter table public.business_profiles
  drop column if exists postal_code;

alter table public.business_profiles
  drop column if exists state_province;

alter table public.business_profiles
  drop column if exists city;

alter table public.business_profiles
  drop column if exists address_line2;

alter table public.business_profiles
  drop column if exists address_line1;

alter table public.countries
  drop constraint if exists countries_code_unique;

commit;
