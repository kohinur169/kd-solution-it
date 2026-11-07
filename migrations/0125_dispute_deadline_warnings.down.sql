-- path: migrations/0125_dispute_deadline_warnings.down.sql
-- STEP 196 - the rollback of the two deadline warnings.
--
-- Reverses the forward file in the only order that works: the triggers go before the functions they call, and
-- the table goes last because a trigger body that lingered would be a function the table's own rows still
-- point at. One transaction, so a failed rollback leaves the database as it found it.
--
-- The rollback forgets *which* warnings were sent. It does not forget that emails were sent: those rows are
-- `0061`'s `email_send_logs`, which this STEP never writes to in a way its own schema could not describe -
-- `template_key = 'dispute_update'`, `reference_kind = 'dispute'` - so a database that reverses this file
-- still knows every message the merchant received and only loses the stage it belonged to. The sweep would
-- then re-warn a merchant once, which is the cost of the rollback and is stated rather than hidden.
--
-- Nothing here touches `disputes`, `email_send_logs`, `email_templates` or `email_settings`: this STEP
-- appended a record beside them and never wrote onto them.

begin;

drop trigger if exists dispute_deadline_warnings_guard_append_only on public.dispute_deadline_warnings;
drop trigger if exists dispute_deadline_warnings_guard_window on public.dispute_deadline_warnings;

drop table if exists public.dispute_deadline_warnings;

drop function if exists public.dispute_deadline_warnings_guard_append_only();
drop function if exists public.dispute_deadline_warnings_guard_window();

commit;
