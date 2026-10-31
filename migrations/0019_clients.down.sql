-- path: migrations/0019_clients.down.sql
-- STEP 020 - rollback for 0019_clients.sql.
--
-- Drops the client table and everything it owns: eighteen constraints, three indexes, the policy and
-- the row metadata trigger. Nothing references this table yet, so it may run before or after the
-- product and service rollbacks; STEP 021 will make this one go last.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.clients;

commit;
