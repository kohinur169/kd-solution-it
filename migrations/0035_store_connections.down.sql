-- path: migrations/0035_store_connections.down.sql
-- STEP 023 - rollback for 0035_store_connections.sql.
--
-- Drops the store connection table and everything it owns: eighteen constraints, two indexes, the
-- policy and the two triggers, then the identity guard function this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.store_connections;

drop function if exists public.store_connections_guard_identity();

commit;
