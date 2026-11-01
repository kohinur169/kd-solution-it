-- path: migrations/0063_support_ticket_messages.down.sql
-- STEP 032 - the rollback of the support messages table: the guard function and the table, in
-- one transaction.

begin;

drop table if exists public.support_ticket_messages;

drop function if exists public.support_ticket_messages_guard_state();

commit;
