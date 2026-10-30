-- path: migrations/0001_companies.down.sql
-- STEP 012 - rollback for 0001_companies.sql.
--
-- Drops the tenant table before the functions it depends on: the id default references
-- public.uuid_generate_v7() and the trigger references public.set_row_metadata(), so both
-- functions must outlive the table. Policies, indexes, constraints, comments and the trigger are
-- owned by the table and disappear with it.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.companies;

drop function if exists public.set_row_metadata();

drop function if exists public.uuid_generate_v7();

commit;
