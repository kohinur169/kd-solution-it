-- path: migrations/0033_idempotency_keys.down.sql
-- STEP 023 - rollback for 0033_idempotency_keys.sql.
--
-- Drops the idempotency table and everything it owns: fourteen constraints, three indexes, the policy
-- and the two triggers, then the state guard function this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.idempotency_keys;

drop function if exists public.idempotency_keys_guard_state();

commit;
