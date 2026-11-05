-- path: migrations/0119_recurring_idempotency.sql
-- STEP 123 - one recurring invoice per schedule occurrence, one reminder per occurrence.
--
-- `0028` built the recurring schedule and `0022` built the invoice, but neither can answer the only
-- question a scheduler asks twice: "has this already happened?" A job that runs every hour, is retried
-- after a timeout, or is delivered twice by a queue must produce one invoice per occurrence and one
-- reminder per occurrence, and it must be able to prove that in the database rather than by reading
-- first and hoping no second writer arrived in between.
--
-- ## Why the service alone cannot do it
--
-- The idempotency STEP 123 needs is a uniqueness statement, and uniqueness that lives in application
-- code is a read followed by a write. Two workers that run the same schedule at the same second both
-- read "no invoice for this run", both insert, and the merchant sends the client two invoices for one
-- month. The check and the write have to be one indivisible act, which in PostgreSQL means an index.
--
-- ## What this file adds
--
--   invoices.recurring_schedule_id  which schedule produced this invoice, null for a hand-written one
--   invoices.recurring_run_on       the occurrence date this invoice bill, not the day the job ran
--
-- The pairing is what makes the occurrence identify itself. `recurring_run_on` is deliberately the
-- schedule's own date rather than a timestamp: a job that runs late, or is retried the next morning,
-- is still filling the occurrence it was scheduled for, and `now()` would make every retry a new
-- invoice.
--
-- `invoices_recurring_run_key` is the unique partial index over `(company_id, recurring_schedule_id,
-- recurring_run_on)` where the schedule is not null. The `company_id` is in the key because the rest
-- of the schema scopes every foreign key by tenant; the partial predicate keeps every hand-written
-- invoice outside the constraint, so two drafts a merchant typed on the same day are still allowed.
--
-- `invoice_events.dedupe_key` carries the same idea to the timeline. An `overdue_reminder` row is the
-- record that an occurrence was queued, and the key names which occurrence it was - the invoice, the
-- reminder ordinal, and the schedule date the reminder belongs to. `invoice_events_dedupe_key_key` is
-- the unique partial index over `(company_id, dedupe_key)` where the key is not null.
--
-- ## Why the event table needed a new column rather than a convention
--
-- `0024` keeps `invoice_events` append only through `invoice_events_guard_append_only`, which raises on
-- every update and every delete, and it carries no unique constraint of any kind (`grep -c unique`
-- against it is zero). There is therefore no existing shape in which "this reminder is already recorded"
-- can be expressed, and the timeline cannot be edited afterwards to add one. The column has to arrive
-- with the index in the same transaction, before the first reminder is written.
--
-- ## What is not changed
--
-- `0022`'s status vocabulary, `invoices_issue_check`, `invoices_number_key` and every trigger on
-- `invoices` are untouched: a generated invoice is a draft with no number and no `issued_at`, exactly
-- as `createInvoice` already writes one. `0024`'s append-only guard is untouched, so a reminder row is
-- still immutable once written - which is why the key is decided before the insert rather than updated
-- after it. `0028` is untouched. No row is dropped and no column is rewritten, so both indexes can be
-- built on an existing table with existing data.

begin;

-- Which schedule produced the invoice, and which of its occurrences the invoice bills.
-- Both are null for an invoice a merchant wrote by hand, which is every row that exists today.
alter table public.invoices
  add column recurring_schedule_id uuid,
  add column recurring_run_on date;

-- A plain reference by id, not the tenant-scoped `(id, company_id)` pairing that `0022` and `0024`
-- use with each other. A composite foreign key needs a matching unique constraint on the referenced
-- side, and `0028` has only its primary key on `(id)`: adding `recurring_schedules_tenant_key` would
-- mean altering a table another STEP owns, which this STEP does not do. The tenant is therefore held
-- by the index below, which is scoped by `company_id`, and by the service, which reads the schedule
-- through the session's company before it writes anything.
alter table public.invoices
  add constraint invoices_recurring_schedule_fkey
  foreign key (recurring_schedule_id)
  references public.recurring_schedules (id);

-- A run date without a schedule is meaningless, and a schedule is only ever named together with the
-- occurrence it is filling. Either both columns are set or neither is.
alter table public.invoices
  add constraint invoices_recurring_pair_check check (
    (recurring_schedule_id is null) = (recurring_run_on is null)
  );

-- The database's own answer to a double run. Partial, so hand-written invoices are unaffected.
create unique index invoices_recurring_run_key
  on public.invoices (company_id, recurring_schedule_id, recurring_run_on)
  where recurring_schedule_id is not null;

comment on column public.invoices.recurring_schedule_id is
  'The recurring schedule that produced this invoice, null when the invoice was written by hand.';

comment on column public.invoices.recurring_run_on is
  'The schedule occurrence date this invoice bills, which is not the day the job happened to run.';

comment on index public.invoices_recurring_run_key is
  'One invoice per schedule occurrence: a repeated or concurrent run of the same date collides here.';

-- The occurrence a timeline row records, so a retried reminder cannot be recorded twice.
-- Null on every existing row and on every event that is not an occurrence.
alter table public.invoice_events
  add column dedupe_key text;

alter table public.invoice_events
  add constraint invoice_events_dedupe_key_check check (
    dedupe_key is null
    or (char_length(dedupe_key) between 8 and 200 and dedupe_key = btrim(dedupe_key))
  );

-- Scoped by tenant so one merchant's key can never collide with another's. Partial, so the timeline
-- of every view, note and status change carries on without a key.
create unique index invoice_events_dedupe_key_key
  on public.invoice_events (company_id, dedupe_key)
  where dedupe_key is not null;

comment on column public.invoice_events.dedupe_key is
  'Names the occurrence this row records, so a retried job cannot append the same reminder twice.';

comment on index public.invoice_events_dedupe_key_key is
  'One row per occurrence within a merchant; null keys - all non-occurrence events - are exempt.';

commit;
