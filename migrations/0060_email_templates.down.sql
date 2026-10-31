-- path: migrations/0060_email_templates.down.sql
-- STEP 032 - the rollback of the email templates table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.email_templates;

drop function if exists public.email_templates_guard_state();

commit;
