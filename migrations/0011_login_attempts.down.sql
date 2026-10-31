-- path: migrations/0011_login_attempts.down.sql
-- STEP 016 - rollback for 0011_login_attempts.sql.
--
-- Drops the login attempt record and everything it owns: thirteen constraints, four indexes, the
-- policy and the row metadata trigger. The lock table is created by 0012 and does not reference
-- this one, so it is dropped by its own rollback.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.login_attempts;

commit;
