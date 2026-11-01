-- path: migrations/0029_payment_providers.down.sql
-- STEP 023 - rollback for 0029_payment_providers.sql.
--
-- Drops the provider catalogue and everything it owns: fourteen constraints, two indexes, the policy
-- and the metadata trigger. It runs last of the provider tables, because provider keys and routing
-- rules point at it.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.payment_providers;

commit;
