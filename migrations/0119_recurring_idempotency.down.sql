-- path: migrations/0119_recurring_idempotency.down.sql
-- Rollback of 0119: remove the two occurrence identities and the two indexes that enforce them.
--
-- ## What comes back
--
-- The forward file adds two nullable columns to `invoices`, one nullable column to `invoice_events`,
-- one non-unique constraint, two check constraints and two unique partial indexes. None of them is a
-- table, and none of them rewrites a row, so the rollback is the exact inverse and nothing else.
--
-- The indexes are dropped before the columns they cover, because an index cannot outlive its columns;
-- the constraints are dropped first of all, because a check constraint naming a column would block the
-- column drop. The order below is the reverse of the forward file's order.
--
-- ## What a rollback costs, stated rather than discovered
--
-- After this file a scheduler has no way to tell an occurrence it already filled from one it has not.
-- Rows already generated keep their `recurring_schedule_id` and `recurring_run_on` until the column
-- goes, and the invoices themselves survive: dropping a column does not delete the invoice a merchant
-- has already shown a client. Reminder rows keep their `dedupe_key` until the column goes and the
-- timeline is still append only, so the events written before the rollback stay exactly as written.
--
-- A re-applied forward file cannot recreate the same guarantee for rows written after the rollback,
-- because the keys those runs would have carried were never stored. That is the honest cost of a
-- rollback here: the data is intact, the duplicate protection is not retroactive.

begin;

drop index if exists public.invoice_events_dedupe_key_key;

alter table public.invoice_events
  drop constraint if exists invoice_events_dedupe_key_check;

alter table public.invoice_events
  drop column if exists dedupe_key;

drop index if exists public.invoices_recurring_run_key;

alter table public.invoices
  drop constraint if exists invoices_recurring_pair_check;

alter table public.invoices
  drop constraint if exists invoices_recurring_schedule_fkey;

alter table public.invoices
  drop column if exists recurring_run_on,
  drop column if exists recurring_schedule_id;

commit;
