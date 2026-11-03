-- path: migrations/0104_merchant_category_code.down.sql
-- STEP 081 rollback of 0104: removes the merchant category code from the business profile and the
-- unique constraint that let the profile reference the code list, and touches nothing else.
--
-- Everything this file removes was created by `0104` and by nothing else: the column, its format
-- check, its foreign key, its index, and the unique constraint on `mcc_codes.code`. The tables of
-- `0077` (the code list, 981 rows) and `0103` (the profiles) are other files' rows and stay as they
-- were. A rollback here means "the platform no longer stores a merchant category code": the audit
-- chain is append-only and outside every rollback, so every save stays recorded even though the
-- column goes, which is why this file is run last and never while a merchant is waiting for an
-- underwriting decision that reads the code.

begin;

drop index if exists public.business_profiles_mcc_idx;

alter table public.business_profiles
  drop constraint if exists business_profiles_mcc_fkey;

alter table public.business_profiles
  drop constraint if exists business_profiles_mcc_code_check;

alter table public.business_profiles
  drop column if exists mcc_code;

alter table public.mcc_codes
  drop constraint if exists mcc_codes_code_unique;

commit;
