-- path: migrations/0120_invoice_overdue_event.down.sql
-- Rollback of 0120: restore the nine-word type vocabulary of `0024`.
--
-- ## What comes back
--
-- The forward file re-declares one check constraint and adds one index; the rollback re-declares the
-- constraint as `0024` wrote it and drops the index. No column, no row is touched by either direction,
-- so the rollback is the exact inverse and nothing else.
--
-- ## What a rollback costs, stated rather than discovered
--
-- Restoring the constraint re-validates every timeline row against the nine words. While no `overdue`
-- event has been written, that validation passes and the rollback is clean. Once a sweep has written one,
-- the validation fails and the rollback is refused - which is the right behaviour, because stripping a
-- word from a vocabulary the timeline already uses would leave rows no constraint describes. The
-- constraint, not the migration, is what decides the rollback is safe, and it decides it against the
-- data rather than against hope.

begin;

drop index public.invoices_due_reminder_idx;

alter table public.invoice_events
  drop constraint invoice_events_type_check;

alter table public.invoice_events
  add constraint invoice_events_type_check check (
    type in ('created', 'sent', 'viewed', 'payment_received', 'paid', 'overdue_reminder', 'voided',
             'duplicated', 'note')
  );

commit;
