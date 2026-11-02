-- path: migrations/0105_business_address.sql
-- STEP 082 - the registered address and the contact person on the business profile row of 0103.
--
-- Section 5's field list names "business address, person name, contact information", and 0102's
-- `address` step is described as "the registered address and the contact details of the person who
-- owns the account". Like the category code of 0104, these facts live on the one `business_profiles`
-- row: the onboarding address form and any profile settings screen edit the same columns, and every
-- section 6 adapter reads the same address when it opens a sub-merchant. A second table would let
-- the two surfaces disagree, which is the mistake 0103 was written to avoid.
--
-- ## The columns
--
--   - `address_line1`, `address_line2` - the street lines of the registered address; line two is
--     optional (a building, a floor, a district) and clears with an empty save;
--   - `city`, `state_province` - the locality; the state or province is optional because not every
--     country divides itself that way;
--   - `postal_code` - 3 to 12 characters of letters, digits, spaces and hyphens, so formats like
--     `SW1A 1AA` and `10001` both fit;
--   - `country_code` - the ISO 3166-1 alpha-2 code of `0076`, upper case, pointing at a row of
--     `public.countries`; the foreign key needs a unique constraint on `code`, and 0076's unique
--     index is partial, so this file adds the full `countries_code_unique` - safe because 0076's
--     guard refuses every delete and every soft delete;
--   - `contact_name`, `contact_email`, `contact_phone` - the person who owns the account, with the
--     email lower cased and the phone in the shape the settings registry of STEP 074 already
--     validates (`+` optional, then digits, spaces, parentheses and hyphens).
--
-- ## The completion rule, kept in the database like 0103's
--
-- `address_completed_at` is derived, never posted by a form: the service stamps it when the seven
-- required fields (everything but `address_line2` and `state_province`) are present and clears it
-- when a later save removes one - the same rule 0103 puts on `completed_at`. The check constraint
-- here is the same rule at the database level, so a row cannot claim an address step complete
-- without the facts, whatever a future caller does. The `address` step of the wizard is finished
-- exactly when this instant is set; the service mirrors that into 0102.
--
-- Whether the whole profile counts as "complete" for the processors stays 0103's rule and is not
-- touched here: 0103 is append-only, and the address section owns its own completion instant.
--
-- ## Why the enabled check is not a constraint
--
-- A country can be switched off or sanctioned without a migration (`is_enabled` changes at
-- runtime), so "the address country must be an enabled country" is the service's rule - the same
-- split as 0104's retired codes - while the foreign key keeps the reference itself honest.

begin;

-- A foreign key can only reference a unique constraint, and 0076's unique index on `code` is
-- partial. The guard of 0076 refuses every delete, so every row is live and the full constraint
-- is the same rule over the whole table.
alter table public.countries
  add constraint countries_code_unique unique (code);

alter table public.business_profiles add column address_line1 text;
alter table public.business_profiles add column address_line2 text;
alter table public.business_profiles add column city text;
alter table public.business_profiles add column state_province text;
alter table public.business_profiles add column postal_code text;
alter table public.business_profiles add column country_code text;
alter table public.business_profiles add column contact_name text;
alter table public.business_profiles add column contact_email text;
alter table public.business_profiles add column contact_phone text;
alter table public.business_profiles add column address_completed_at timestamptz;

alter table public.business_profiles
  add constraint business_profiles_address_line1_check check (
    address_line1 is null
    or (char_length(address_line1) between 2 and 120 and address_line1 = btrim(address_line1))
  );

alter table public.business_profiles
  add constraint business_profiles_address_line2_check check (
    address_line2 is null
    or (char_length(address_line2) between 1 and 120 and address_line2 = btrim(address_line2))
  );

alter table public.business_profiles
  add constraint business_profiles_city_check check (
    city is null
    or (char_length(city) between 2 and 80 and city = btrim(city))
  );

alter table public.business_profiles
  add constraint business_profiles_state_check check (
    state_province is null
    or (char_length(state_province) between 1 and 80 and state_province = btrim(state_province))
  );

alter table public.business_profiles
  add constraint business_profiles_postal_check check (
    postal_code is null
    or (
      char_length(postal_code) between 3 and 12
      and postal_code ~ '^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$'
      and postal_code = btrim(postal_code)
    )
  );

alter table public.business_profiles
  add constraint business_profiles_country_code_check check (
    country_code is null or country_code ~ '^[A-Z]{2}$'
  );

alter table public.business_profiles
  add constraint business_profiles_country_fkey
  foreign key (country_code) references public.countries (code);

alter table public.business_profiles
  add constraint business_profiles_contact_name_check check (
    contact_name is null
    or (char_length(contact_name) between 2 and 120 and contact_name = btrim(contact_name))
  );

alter table public.business_profiles
  add constraint business_profiles_contact_email_check check (
    contact_email is null
    or (
      char_length(contact_email) between 5 and 254
      and contact_email = lower(contact_email)
      and contact_email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    )
  );

alter table public.business_profiles
  add constraint business_profiles_contact_phone_check check (
    contact_phone is null
    or (char_length(contact_phone) between 7 and 33 and contact_phone ~ '^\+?[0-9][0-9 ()-]{5,31}$')
  );

-- A row cannot claim the address step complete without the seven required fields.
alter table public.business_profiles
  add constraint business_profiles_address_completed_check check (
    address_completed_at is null
    or (
      address_line1 is not null
      and city is not null
      and postal_code is not null
      and country_code is not null
      and contact_name is not null
      and contact_email is not null
      and contact_phone is not null
    )
  );

alter table public.business_profiles
  add constraint business_profiles_address_completed_instant_check check (
    address_completed_at is null or address_completed_at >= created_at
  );

-- The office screens: which merchants are registered in which country.
create index business_profiles_country_idx
  on public.business_profiles (country_code)
  where deleted_at is null and country_code is not null;

comment on column public.business_profiles.address_line1 is
  'The first street line of the registered business address, 2 to 120 characters, trimmed. Required for the address step.';

comment on column public.business_profiles.address_line2 is
  'The second street line of the registered address when there is one. Optional.';

comment on column public.business_profiles.city is
  'The city or locality of the registered address, 2 to 80 characters, trimmed. Required for the address step.';

comment on column public.business_profiles.state_province is
  'The state, province or region of the registered address when the country has them. Optional.';

comment on column public.business_profiles.postal_code is
  'The postal code of the registered address, 3 to 12 characters of letters, digits, spaces and hyphens. Required for the address step.';

comment on column public.business_profiles.country_code is
  'The ISO 3166-1 alpha-2 code of the registered address country, one row of public.countries. Required for the address step; the service also requires the country to be enabled.';

comment on column public.business_profiles.contact_name is
  'The name of the person who owns the account and answers for the business, 2 to 120 characters, trimmed. Required for the address step.';

comment on column public.business_profiles.contact_email is
  'The email address of the contact person, lower cased, 5 to 254 characters. Required for the address step.';

comment on column public.business_profiles.contact_phone is
  'The phone number of the contact person, optional leading plus, digits, spaces, parentheses and hyphens. Required for the address step.';

comment on column public.business_profiles.address_completed_at is
  'When all seven required address and contact fields were present. Null while the address section is a draft; the address step of the onboarding wizard is finished exactly when this is set.';

commit;
