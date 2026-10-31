-- path: migrations/0032_webhook_events.down.sql
-- STEP 023 - rollback for 0032_webhook_events.sql.
--
-- Drops the webhook event table and everything it owns: fifteen constraints, three indexes, the
-- policy and the two triggers, then the evidence guard function this file created. It runs before the
-- provider catalogue rollback, because every event points at a provider.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.webhook_events;

drop function if exists public.webhook_events_guard_evidence();

commit;
