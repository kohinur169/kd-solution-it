-- path: migrations/0009_device_proof_keys.down.sql
-- STEP 015 - rollback for 0009_device_proof_keys.sql.
--
-- Drops the device proof key table and everything it owns: thirteen constraints, four indexes, the
-- policy and the row metadata trigger. Tables from earlier migrations stay untouched, which is why
-- this file has to run before 0010 is rolled back: the session table references this one.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.device_proof_keys;

commit;
