-- path: migrations/0024_invoice_events.down.sql
-- STEP 021 - rollback for 0024_invoice_events.sql.
--
-- Drops the timeline and everything it owns: eleven constraints, three indexes, the policy and the
-- append only guard trigger, then the guard function. It runs first, before the line and invoice
-- rollbacks, because the events point at an invoice.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.invoice_events;

drop function if exists public.invoice_events_guard_append_only();

commit;
