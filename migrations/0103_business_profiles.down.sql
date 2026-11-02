-- path: migrations/0103_business_profiles.down.sql
-- STEP 080 rollback of 0103: removes the stored business facts and everything that hung off it.
--
-- Everything this file drops was created by `0103` and by nothing else: the table, its one live row
-- per company index, its metadata trigger and its default-deny policy. `0001` (companies), `0003`
-- (users), `0102` (the onboarding position this table's completion feeds) and `0013` (the audit chain)
-- are other files' rows and are untouched.
--
-- A rollback here means "the platform no longer stores business information". It does not mean a
-- merchant never filled it in: every save was an audited act, and the audit chain is append-only and
-- outside every rollback. A database holding profiles loses them, which is why this file is run last
-- and never while a merchant is waiting for an underwriting decision on the facts it removes.

begin;

drop policy if exists business_profiles_default_deny on public.business_profiles;

drop trigger if exists business_profiles_set_row_metadata on public.business_profiles;

drop index if exists public.business_profiles_company_key;

drop table if exists public.business_profiles;

commit;
