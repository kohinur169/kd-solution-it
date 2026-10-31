-- path: migrations/0062_support_tickets.sql
-- STEP 032 - the support tickets of section 24: one row per request a merchant opens.
--
-- Section 24 asks for tickets a merchant creates and support assigns, with a status the office
-- moves, and for a service level that is recorded rather than promised. The record is three
-- instants and one generated answer: `first_response_due_at` is the deadline the service
-- computed, `first_responded_at` is when a person actually answered, and `first_response_on_time`
-- is a stored generated column, so the metric cannot drift from the row it describes.
--
-- The 72 hour promise for a stuck payment is a check. `support_tickets_stuck_due_check` refuses a
-- `payment_stuck` ticket whose first response is due later than `created_at + 72 hours`, so the
-- one promise section 24 states in hours cannot be broken by arithmetic in a service. The one
-- business day promise of a monetary urgent matter is not a check, because a business calendar is
-- a setting: the service writes the due instant it computed from `config/`.
--
-- `support_tickets_guard_state` refuses an opener of another merchant, freezes the merchant, the
-- opener, the subject, the category and the first response deadline, walks the status from `open`
-- to `pending_merchant`, `resolved` and `closed` and never back, writes each instant once, and
-- refuses a delete: a ticket is closed, never removed, because the service level record of
-- section 24 would vanish with it.

begin;

create function public.support_tickets_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform 1 from public.users
    where id = new.opened_by and company_id = new.company_id;

    if not found then
      raise exception 'a ticket opener belongs to the merchant of the ticket'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  if new.company_id is distinct from old.company_id
     or new.opened_by is distinct from old.opened_by
     or new.subject is distinct from old.subject
     or new.category is distinct from old.category
     or new.first_response_due_at is distinct from old.first_response_due_at then
    raise exception 'a ticket keeps its merchant, its opener, its subject and its deadline'
      using errcode = 'check_violation';
  end if;

  if old.first_responded_at is not null
     and new.first_responded_at is distinct from old.first_responded_at then
    raise exception 'a first response is recorded once and never rewritten'
      using errcode = 'check_violation';
  end if;

  if old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at then
    raise exception 'a ticket resolution is recorded once'
      using errcode = 'check_violation';
  end if;

  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    raise exception 'a ticket close instant is recorded once'
      using errcode = 'check_violation';
  end if;

  if old.status is distinct from new.status and not (
    (old.status = 'open' and new.status in ('pending_merchant', 'resolved', 'closed'))
    or (old.status = 'pending_merchant' and new.status in ('open', 'resolved', 'closed'))
    or (old.status = 'resolved' and new.status = 'closed')
  ) then
    raise exception 'a ticket walks from open to pending, resolved or closed, and never back'
      using errcode = 'check_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a support ticket is closed, never deleted'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.support_tickets_guard_state() is
  'Refuses a foreign opener, freezes the ticket identity and walks its status forward.';

create table public.support_tickets (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  opened_by uuid not null,
  subject text not null,
  category text not null default 'general',
  priority text not null default 'normal',
  status text not null default 'open',
  assigned_to uuid,
  assigned_at timestamptz,
  first_response_due_at timestamptz not null,
  first_responded_at timestamptz,
  first_response_on_time boolean generated always as (
    case
      when first_responded_at is null then null
      else first_responded_at <= first_response_due_at
    end
  ) stored,
  resolution_due_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  resolution_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint support_tickets_pkey primary key (id),
  constraint support_tickets_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint support_tickets_opened_by_fkey foreign key (opened_by)
    references public.users (id),
  constraint support_tickets_assigned_to_fkey foreign key (assigned_to)
    references public.users (id),
  constraint support_tickets_subject_check check (
    char_length(subject) between 3 and 160
    and subject = btrim(subject)
  ),
  constraint support_tickets_category_check check (
    category in ('general', 'payment_stuck', 'billing', 'kyc', 'technical', 'security', 'other')
  ),
  constraint support_tickets_priority_check check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  constraint support_tickets_status_check check (
    status in ('open', 'pending_merchant', 'resolved', 'closed')
  ),
  constraint support_tickets_assign_check check (
    (assigned_to is null) = (assigned_at is null)
  ),
  constraint support_tickets_due_check check (first_response_due_at >= created_at),
  constraint support_tickets_stuck_due_check check (
    category <> 'payment_stuck'
    or first_response_due_at <= created_at + interval '72 hours'
  ),
  constraint support_tickets_response_check check (
    first_responded_at is null or first_responded_at >= created_at
  ),
  constraint support_tickets_resolution_due_check check (
    resolution_due_at is null or resolution_due_at >= created_at
  ),
  constraint support_tickets_resolved_check check (
    (status in ('resolved', 'closed')) = (resolved_at is not null)
  ),
  constraint support_tickets_closed_check check (
    (status = 'closed') = (closed_at is not null)
  ),
  constraint support_tickets_summary_check check (
    resolution_summary is null
    or (
      char_length(resolution_summary) between 1 and 2000
      and resolution_summary = btrim(resolution_summary)
    )
  ),
  constraint support_tickets_updated_check check (updated_at >= created_at),
  constraint support_tickets_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint support_tickets_row_version_check check (version > 0)
);

comment on table public.support_tickets is
  'One merchant support ticket of section 24, with its service level instants and its status.';

comment on column public.support_tickets.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.support_tickets.company_id is
  'The merchant that opened the ticket.';

comment on column public.support_tickets.opened_by is
  'The person who opened it, which the guard requires to belong to the same merchant.';

comment on column public.support_tickets.subject is
  'The one line subject, 3 to 160 characters, frozen after the row is written.';

comment on column public.support_tickets.category is
  'What the ticket is about; payment_stuck carries the 72 hour promise of section 24.';

comment on column public.support_tickets.priority is
  'low, normal, high or urgent, the queue order the office applies.';

comment on column public.support_tickets.status is
  'open, pending_merchant, resolved or closed. The guard walks it forward only.';

comment on column public.support_tickets.assigned_to is
  'The office person the ticket is assigned to, null while it waits in the queue.';

comment on column public.support_tickets.assigned_at is
  'When it was assigned, present exactly when assigned_to is.';

comment on column public.support_tickets.first_response_due_at is
  'The deadline for the first response, computed by the service from the section 24 promise.';

comment on column public.support_tickets.first_responded_at is
  'When a person first answered. Written once.';

comment on column public.support_tickets.first_response_on_time is
  'Stored generated answer to whether the first response met its deadline, null until it happens.';

comment on column public.support_tickets.resolution_due_at is
  'The deadline for the resolution, null when the category carries no second promise.';

comment on column public.support_tickets.resolved_at is
  'When the ticket was resolved. Required by the resolved and closed states.';

comment on column public.support_tickets.closed_at is
  'When it was closed. Required by the closed state.';

comment on column public.support_tickets.resolution_summary is
  'The office note that closes the ticket, up to 2000 characters.';

comment on column public.support_tickets.created_at is
  'When the ticket was opened, which the due checks measure from.';

comment on column public.support_tickets.updated_at is
  'Set by the support_tickets_set_row_metadata trigger on every update.';

comment on column public.support_tickets.deleted_at is
  'Present for the schema rule; the guard refuses a value, because a ticket is closed instead.';

comment on column public.support_tickets.version is
  'Optimistic locking counter, incremented by the support_tickets_set_row_metadata trigger.';

-- The merchant list: its tickets by status, newest first.
create index support_tickets_company_idx
  on public.support_tickets (company_id, status, created_at desc)
  where deleted_at is null;

-- The office queue: what one person was assigned, still open.
create index support_tickets_assignee_idx
  on public.support_tickets (assigned_to, status)
  where assigned_to is not null and deleted_at is null;

-- The service level sweep: tickets whose first response is still owed.
create index support_tickets_due_idx
  on public.support_tickets (first_response_due_at)
  where first_responded_at is null and deleted_at is null;

create trigger support_tickets_guard_state
  before insert or update on public.support_tickets
  for each row
  execute function public.support_tickets_guard_state();

create trigger support_tickets_set_row_metadata
  before update on public.support_tickets
  for each row
  execute function public.set_row_metadata();

alter table public.support_tickets enable row level security;

create policy support_tickets_default_deny
  on public.support_tickets
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
