-- path: migrations/0061_email_send_logs.down.sql
-- STEP 032 - the rollback of the send log table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.email_send_logs;

drop function if exists public.email_send_logs_guard_state();

commit;
