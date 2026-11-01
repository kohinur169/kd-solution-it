-- path: migrations/0030_provider_keys.down.sql
-- STEP 023 - rollback for 0030_provider_keys.sql.
--
-- Drops the key table and everything it owns: twenty one constraints, four indexes, the policy and
-- the two triggers, then the secret guard function this file created. It runs before the provider
-- catalogue rollback, because every key points at a provider.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.provider_keys;

drop function if exists public.provider_keys_guard_secret();

commit;
