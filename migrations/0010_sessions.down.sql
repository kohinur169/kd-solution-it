-- path: migrations/0010_sessions.down.sql
-- STEP 015 - rollback for 0010_sessions.sql.
--
-- Drops the session table and everything it owns: eighteen constraints, six indexes, the policy and
-- the row metadata trigger. It runs before 0009 because the session table references the device key
-- table; the device table itself is dropped by its own rollback.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.sessions;

commit;
