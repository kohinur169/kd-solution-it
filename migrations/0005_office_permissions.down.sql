-- path: migrations/0005_office_permissions.down.sql
-- STEP 014 - rollback for 0005_office_permissions.sql.
--
-- Drops the delegated permission table and everything it owns: constraints, three indexes, the
-- policy and the row metadata trigger. Tables from earlier migrations stay untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.office_permissions;

commit;
