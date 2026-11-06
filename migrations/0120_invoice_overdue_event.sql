-- path: migrations/0120_invoice_overdue_event.sql
-- The `overdue` word of the invoice timeline.
--
-- Section 16 names seven states, and `0022` carries all seven as a check on the invoice row. But the
-- timeline of `0024` has a word for a reminder that was recorded (`overdue_reminder`) and none for the
-- state change itself: a sweep that moves an invoice past its due date to `overdue` has no word to write,
-- and a timeline that records the reminder but not the state it reminds about is a record that answers
-- the wrong question.
--
-- The move is the state's own fact: one row, the actor is the system that swept, and no person is named,
-- because a scheduled sweep has no person behind it. `overdue_reminder` stays as it is - the reminder is
-- a different fact, and the two rows together are what a support call months later reads: when the
-- document became overdue, and when the client was told.
--
-- The reminder index: `0022`'s `invoices_due_idx` was built for the sweep that *finds* due documents,
-- so its predicate stops at `partially_paid` - an `overdue` document is found by nothing, it simply
-- is. But a document that has become overdue is exactly the one whose reminders must go on, and the
-- recurring reminder sweep reads the open documents past their due date, `overdue` among them. That
-- sweep's predicate is this index: the same four statuses, `deleted_at is null`, keyed the same way.
-- `invoices_due_idx` stays as it is, because the sweep that moves documents to `overdue` still reads
-- the three statuses it was built for.

begin;

alter table public.invoice_events
  drop constraint invoice_events_type_check;

alter table public.invoice_events
  add constraint invoice_events_type_check check (
    type in ('created', 'sent', 'viewed', 'payment_received', 'paid', 'overdue', 'overdue_reminder',
             'voided', 'duplicated', 'note')
  );

create index invoices_due_reminder_idx
  on public.invoices (company_id, due_at)
  where status in ('sent', 'viewed', 'partially_paid', 'overdue') and deleted_at is null;

commit;
