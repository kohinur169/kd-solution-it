-- path: migrations/0059_email_settings.down.sql
-- STEP 032 - the rollback of the email settings table: the guard function and the table, in one
-- transaction, so a failed drop leaves nothing half removed.

begin;

drop table if exists public.email_settings;

drop function if exists public.email_settings_guard_state();

commit;
