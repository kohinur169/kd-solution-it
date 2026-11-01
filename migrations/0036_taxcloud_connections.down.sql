-- path: migrations/0036_taxcloud_connections.down.sql
-- STEP 023 - rollback for 0036_taxcloud_connections.sql.
--
-- Drops the TaxCloud connection table and everything it owns: eighteen constraints, two indexes, the
-- policy and the two triggers, then the credential guard function this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.taxcloud_connections;

drop function if exists public.taxcloud_connections_guard_credentials();

commit;
