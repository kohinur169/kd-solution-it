-- path: migrations/0062_support_tickets.down.sql
-- STEP 032 - the rollback of the support ticket table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.support_tickets;

drop function if exists public.support_tickets_guard_state();

commit;
