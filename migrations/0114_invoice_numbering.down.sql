-- path: migrations/0114_invoice_numbering.down.sql
-- Rollback of 0114: drop the take function, the period helper, the last-used helper and the two tables.
--
-- The order is the reverse of the forward file. `take_invoice_number` calls the other two functions, so it is
-- dropped first; the two tables go last, settings before its counter because a reader of the counter may
-- want the settings row that produced it.
--
-- Nothing here touches `invoices`. The numbers already printed stay on the invoices that carry them, which is
-- the point of a rollback: what has been sent to a client is not un-sent by a schema change. Only the
-- ability to take the *next* number is removed.

begin;

drop function if exists public.take_invoice_number(uuid, timestamptz);

drop function if exists public.invoice_number_last_used(uuid);

drop function if exists public.invoice_number_period(boolean, integer, timestamptz);

drop policy if exists invoice_number_counters_default_deny on public.invoice_number_counters;
drop policy if exists invoice_number_settings_default_deny on public.invoice_number_settings;

drop trigger if exists invoice_number_counters_set_row_metadata on public.invoice_number_counters;
drop trigger if exists invoice_number_settings_set_row_metadata on public.invoice_number_settings;

drop table if exists public.invoice_number_counters;
drop table if exists public.invoice_number_settings;

commit;
