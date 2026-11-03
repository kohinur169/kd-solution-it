-- path: migrations/0104_merchant_category_code.sql
-- STEP 081 - the merchant category code on the business profile, pointed at the code list of 0077.
--
-- Section 5 asks for a Merchant Category Code "in merchant onboarding and profile settings", and
-- the same section makes the code the basis of a risk tier. STEP 080's `business_profiles` row is
-- the one place the platform stores what a merchant fills once, so the code lives on that row as
-- `mcc_code`: the onboarding category step and any profile settings screen edit the same column,
-- and every section 6 adapter later reads the same four digits. A second table would let the two
-- surfaces disagree about the code, which is the mistake 0103 was written to avoid for the other
-- business facts.
--
-- ## Why the reference goes through `code` and not `id`
--
-- The adapters send the four digit code, not a surrogate key, and 0077's own header says the profile
-- will point at a row of the list. A foreign key can only reference a unique constraint, and 0077's
-- `mcc_codes_code_key` is a partial index, which no foreign key can use, so this file adds the full
-- unique constraint `mcc_codes_code_unique` on `code`. That is safe because 0077's guard trigger
-- refuses every delete and every soft delete, so the partial index already covers every row the
-- table will ever hold.
--
-- ## What the constraints keep honest
--
--   - `business_profiles_mcc_code_check` keeps the code four digits as text, so the codes that
--     begin with zero (`0742`) stay distinct from `742`, exactly as 0077 stores them;
--   - `business_profiles_mcc_fkey` refuses a code no card network publishes, at the database level,
--     whatever a future caller does;
--   - a retired code (`is_active = false`) keeps its row, so the reference stays valid and the
--     history of every merchant that used it stays readable. Refusing a *new* choice of a retired
--     code is the service's rule rather than a constraint here, because `is_active` is a state that
--     changes without a migration and a check constraint cannot see it cheaply.
--
-- `business_profiles_mcc_idx` serves the underwriting screen of STEP 090, which lists profiles by
-- the code they carry.
--
-- The column is deliberately not part of `business_profiles_completed_check` of 0103: the category
-- is the wizard's own `category` step, and whether that step is finished is decided by the service
-- that writes this column, not by the business facts a processor insists on.

begin;

-- A foreign key can only reference a unique constraint, and 0077's unique index on `code` is
-- partial. The guard of 0077 refuses every delete, so every row is live and the full constraint
-- is the same rule over the whole table.
alter table public.mcc_codes
  add constraint mcc_codes_code_unique unique (code);

alter table public.business_profiles
  add column mcc_code text;

alter table public.business_profiles
  add constraint business_profiles_mcc_code_check
  check (mcc_code is null or mcc_code ~ '^[0-9]{4}$');

alter table public.business_profiles
  add constraint business_profiles_mcc_fkey
  foreign key (mcc_code) references public.mcc_codes (code);

-- The underwriting screen: which profiles carry which code.
create index business_profiles_mcc_idx
  on public.business_profiles (mcc_code)
  where deleted_at is null and mcc_code is not null;

comment on column public.business_profiles.mcc_code is
  'The merchant category code of section 5, four digits as text, one row of public.mcc_codes. Null until the merchant chooses one; the category step of the onboarding wizard is finished exactly when it is set.';

commit;
