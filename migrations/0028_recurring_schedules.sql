-- path: migrations/0028_recurring_schedules.sql
-- STEP 022 - the recurring invoice of section 16.
--
-- Section 16: "Recurring invoices exist. When a recurring payment fails there is no automatic retry.
-- The invoice shows as due or overdue, reminders go to the client at set intervals, and the merchant
-- can take the needed action." Section 27 gives the job its name: "Recurring invoice generation and
-- client reminders".
--
-- The lines of a recurring invoice are not a second catalogue here. A schedule points at a draft
-- invoice of the same merchant, the template, and the job copies that invoice and its lines on each
-- run. The template is a real invoice in `invoices`, so it carries the client snapshot, the currency
-- and the arithmetic that STEP 021 already proves, and there is no third place where a price could
-- disagree with another.
--
-- The schedule states its own arithmetic instead of leaving it to code: `interval_unit` with
-- `interval_count`, `start_on`, `next_run_on`, an optional `end_on`, and `terms_days` for the due
-- offset of each generated invoice. A template may drive one schedule per merchant, so two jobs
-- cannot invoice the same template twice in the same period.
--
-- There is deliberately no retry column and no attempt counter anywhere in this table. Section 16
-- says a failed recurring payment is not retried automatically; the invoice of that period simply
-- stays due or overdue, and the merchant acts. The absence is the rule.
--
-- The reminder policy is `reminder_interval_days` and `reminder_limit`: reminders go out at set
-- intervals while the merchant still has to act, and `last_reminder_on` records the last one so the
-- job can count the interval from it. Zero days means no reminders at all, and then the limit is
-- zero as well.

begin;

create function public.recurring_schedules_guard_template()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  template_state text;
  template_company uuid;
begin
  select status, company_id into template_state, template_company
  from public.invoices where id = new.template_invoice_id;

  if template_company is distinct from new.company_id then
    raise exception 'a template invoice must belong to the same merchant'
      using errcode = 'check_violation';
  end if;

  if template_state is distinct from 'draft' then
    raise exception 'a template invoice must still be a draft'
      using errcode = 'check_violation';
  end if;

  if new.client_id is distinct from
     (select client_id from public.invoices where id = new.template_invoice_id) then
    raise exception 'the schedule client must be the template client'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.recurring_schedules_guard_template() is
  'Keeps a schedule pointed at a draft invoice of its own merchant and its own client.';

create table public.recurring_schedules (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  client_id uuid not null,
  template_invoice_id uuid not null,
  status text not null default 'active',
  interval_unit text not null default 'month',
  interval_count integer not null default 1,
  start_on date not null,
  next_run_on date not null,
  end_on date,
  terms_days integer not null default 30,
  reminder_interval_days integer not null default 0,
  reminder_limit integer not null default 0,
  last_run_on date,
  last_reminder_on date,
  paused_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint recurring_schedules_pkey primary key (id),
  constraint recurring_schedules_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint recurring_schedules_client_fkey foreign key (client_id) references public.clients (id),
  constraint recurring_schedules_template_fkey foreign key (template_invoice_id)
    references public.invoices (id),
  constraint recurring_schedules_status_check check (status in ('active', 'paused', 'ended')),
  constraint recurring_schedules_unit_check check (
    interval_unit in ('day', 'week', 'month', 'year')
  ),
  constraint recurring_schedules_count_check check (interval_count between 1 and 60),
  constraint recurring_schedules_next_run_check check (next_run_on >= start_on),
  constraint recurring_schedules_end_check check (end_on is null or end_on >= start_on),
  constraint recurring_schedules_terms_check check (terms_days between 0 and 365),
  constraint recurring_schedules_reminder_interval_check check (
    reminder_interval_days between 0 and 90
  ),
  constraint recurring_schedules_reminder_limit_check check (reminder_limit between 0 and 10),
  constraint recurring_schedules_reminder_pair_check check (
    (reminder_interval_days = 0) = (reminder_limit = 0)
  ),
  constraint recurring_schedules_paused_check check (
    (status = 'paused') = (paused_at is not null)
  ),
  constraint recurring_schedules_ended_check check ((status = 'ended') = (ended_at is not null)),
  constraint recurring_schedules_last_run_check check (
    last_run_on is null or last_run_on >= start_on
  ),
  constraint recurring_schedules_last_reminder_check check (
    last_reminder_on is null or (last_run_on is not null and last_reminder_on >= last_run_on)
  ),
  constraint recurring_schedules_version_positive_check check (version > 0),
  constraint recurring_schedules_updated_after_creation_check check (updated_at >= created_at),
  constraint recurring_schedules_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.recurring_schedules is
  'A repeating invoice: a draft template, an interval, a due offset and a reminder policy.';

comment on column public.recurring_schedules.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.recurring_schedules.company_id is
  'The merchant that owns the schedule and the template.';

comment on column public.recurring_schedules.client_id is
  'The client the template invoices. Must equal the template invoice client.';

comment on column public.recurring_schedules.template_invoice_id is
  'The draft invoice copied on every run. Unique per merchant while the schedule is live.';

comment on column public.recurring_schedules.status is
  'active while the job may run, paused by the merchant, ended for good.';

comment on column public.recurring_schedules.interval_unit is
  'day, week, month or year: what one interval step means.';

comment on column public.recurring_schedules.interval_count is
  'How many units between two runs, 1 to 60.';

comment on column public.recurring_schedules.start_on is
  'The first run date, the anchor of every later one.';

comment on column public.recurring_schedules.next_run_on is
  'Where the section 27 job looks next. Never before the start date.';

comment on column public.recurring_schedules.end_on is
  'Optional last run date, never before the start date.';

comment on column public.recurring_schedules.terms_days is
  'Due offset applied to each generated invoice, 0 to 365 days.';

comment on column public.recurring_schedules.reminder_interval_days is
  'Days between reminders after a due date; zero means the schedule sends none.';

comment on column public.recurring_schedules.reminder_limit is
  'How many reminders one generated invoice may receive; zero when reminders are off.';

comment on column public.recurring_schedules.last_run_on is
  'When the job last generated an invoice, null until the first run.';

comment on column public.recurring_schedules.last_reminder_on is
  'When a reminder last went out for the current cycle, null until the first one.';

comment on column public.recurring_schedules.paused_at is
  'Set exactly when the status is paused.';

comment on column public.recurring_schedules.ended_at is
  'Set exactly when the status is ended.';

comment on column public.recurring_schedules.created_at is
  'When the schedule was created.';

comment on column public.recurring_schedules.updated_at is
  'Set by the recurring_schedules_set_row_metadata trigger on every update.';

comment on column public.recurring_schedules.deleted_at is
  'Soft delete marker. A deleted schedule stays readable for the invoices it produced.';

comment on column public.recurring_schedules.version is
  'Optimistic locking counter. Incremented by the recurring_schedules_set_row_metadata trigger.';

-- One live schedule per template inside one merchant, so a template cannot be invoiced twice a period.
create unique index recurring_schedules_template_key
  on public.recurring_schedules (company_id, template_invoice_id)
  where deleted_at is null;

-- The job of section 27: the schedules that are due, oldest first.
create index recurring_schedules_run_idx
  on public.recurring_schedules (next_run_on)
  where status = 'active' and deleted_at is null;

-- The merchant screen: the schedules of one client.
create index recurring_schedules_client_idx
  on public.recurring_schedules (company_id, client_id, created_at desc)
  where deleted_at is null;

create trigger recurring_schedules_guard_template
  before insert or update on public.recurring_schedules
  for each row
  execute function public.recurring_schedules_guard_template();

create trigger recurring_schedules_set_row_metadata
  before update on public.recurring_schedules
  for each row
  execute function public.set_row_metadata();

alter table public.recurring_schedules enable row level security;

create policy recurring_schedules_default_deny
  on public.recurring_schedules
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
