-- path: migrations/0031_routing_rules.down.sql
-- STEP 023 - rollback for 0031_routing_rules.sql.
--
-- Drops the routing table and everything it owns: sixteen constraints, three indexes, the policy and
-- the two triggers, then the provider guard function this file created. It runs before the provider
-- catalogue rollback, because every rule points at a provider.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.routing_rules;

drop function if exists public.routing_rules_guard_provider();

commit;
