-- path: migrations/0125_dispute_deadline_warnings.sql
-- STEP 196 - section 19's two warnings: "The merchant receives email warnings at the start and in the
-- middle of the deadline window."
--
-- ## What this file is, and what it is not
--
-- It is the record of a warning that was handed to the email system, not the email system itself. Section
-- 23 is a later STEP range (221 to 230): the sending method in `email_settings` (`0059`), the wording in
-- `email_templates` (`0060`), and the queue, its retries and its sweep in `email_send_logs` (`0061`). This
-- file adds the one fact those three cannot hold: *which* of a dispute's two warnings a send row was.
--
-- `0061` stores a template key from a closed list of twenty - `dispute_update` is the one for a dispute -
-- and a reference (`reference_kind = 'dispute'`, `reference_id`) so a renderer can open the record. Neither
-- says whether the message was the warning at the start of the window or the one at its middle, and neither
-- says which window it was about after a super administrator extended it from 24 hours to 48. Those are the
-- two facts this table owns, and they are what makes "the merchant was warned once at the start and once in
-- the middle" a checkable statement instead of a hope.
--
-- ## Why the row is immutable
--
-- A warning is a thing that happened to a person, like a send log: it says the merchant was told, at this
-- instant, about this deadline. A row that could be edited would be a row that could be made to say the
-- merchant was told when they were not, so the guard refuses every update and every removal - the same
-- decision `0061` makes about the parts of a send it freezes and `0122` makes about a buyer's confirmation.
-- The only state that changes afterwards is the send row's own (`queued` to `sent`, `failed` or `dropped`),
-- and it changes there, where `0061`'s guard already walks it.
--
-- ## The three keys
--
--   * `(dispute_id, stage, window_hours)` - one warning per stage per window. A stage is never re-sent for
--     the same window, however often the sweep runs.
--   * `(dispute_id) where stage = 'start'` - the start warning happens once in a dispute's life. An extension
--     from 24 to 48 hours does not re-announce a window that already opened; it moves the *middle*, which is
--     why only the midpoint carries the window in its key.
--   * `(send_id)` - one email cannot claim two warnings, so a retry of the sweep cannot double count.
--
-- ## The window a warning is about, verified rather than trusted
--
-- `dispute_deadline_warnings_guard_window` reads the dispute on insert and refuses a row whose merchant, whose
-- `opened_at`, whose window or whose deadline disagree with the dispute's own. A warning about a deadline the
-- dispute no longer has would be a warning the merchant cannot act on. The arithmetic itself is the checks':
-- the start warning's instant is `opened_at`, the midpoint's is `opened_at + window/2`, the deadline is
-- `opened_at + window`, and a warning is never queued before it is due.
--
-- ## What is deliberately absent
--
-- No recipient address and no subject: `0061` keeps those as they were sent, and a second copy here would be
-- a second truth about who was told. No body and no variables: the renderer reads the dispute through the
-- send row's reference. No status: whether the email left is `email_send_logs.status`, in one place.

begin;

create function public.dispute_deadline_warnings_guard_window()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.disputes as disputes
     where disputes.id = new.dispute_id
       and disputes.company_id = new.company_id
       and disputes.deleted_at is null
       and disputes.opened_at = new.opened_at
       and disputes.response_window_hours = new.window_hours
       and disputes.response_due_at = new.due_at
  ) then
    raise exception 'a warning describes the dispute''s own merchant, opening, window and deadline'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.dispute_deadline_warnings_guard_window() is
  'Refuses a warning about a merchant, an opening, a window or a deadline the dispute does not have.';

create function public.dispute_deadline_warnings_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a deadline warning is history: it is never rewritten and never removed'
    using errcode = 'check_violation';
end;
$$;

comment on function public.dispute_deadline_warnings_guard_append_only() is
  'Refuses every update and every removal: a warning records that a merchant was told, at an instant.';

create table public.dispute_deadline_warnings (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  dispute_id uuid not null,
  stage text not null,
  window_hours integer not null,
  opened_at timestamptz not null,
  warn_at timestamptz not null,
  due_at timestamptz not null,
  send_id uuid not null,
  queued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint dispute_deadline_warnings_pkey primary key (id),
  constraint dispute_deadline_warnings_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint dispute_deadline_warnings_dispute_fkey foreign key (dispute_id)
    references public.disputes (id),
  constraint dispute_deadline_warnings_send_fkey foreign key (send_id)
    references public.email_send_logs (id),
  constraint dispute_deadline_warnings_stage_check check (
    stage in ('start', 'midpoint')
  ),
  constraint dispute_deadline_warnings_window_check check (
    window_hours in (24, 48)
  ),
  constraint dispute_deadline_warnings_instant_check check (
    warn_at >= opened_at
    and warn_at < due_at
    and queued_at >= warn_at
  ),
  constraint dispute_deadline_warnings_midpoint_check check (
    (stage = 'start' and warn_at = opened_at)
    or (stage = 'midpoint'
        and warn_at = opened_at + make_interval(hours => (window_hours / 2)))
  ),
  constraint dispute_deadline_warnings_due_check check (
    due_at = opened_at + make_interval(hours => window_hours)
  ),
  constraint dispute_deadline_warnings_queued_check check (queued_at >= created_at),
  constraint dispute_deadline_warnings_version_check check (version > 0),
  constraint dispute_deadline_warnings_updated_check check (updated_at >= created_at)
);

comment on table public.dispute_deadline_warnings is
  'One of the two deadline warnings of section 19 that the platform handed to the email system for a dispute.';

comment on column public.dispute_deadline_warnings.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.dispute_deadline_warnings.company_id is
  'The merchant that was warned. Equal to the dispute tenant through the guard trigger.';

comment on column public.dispute_deadline_warnings.dispute_id is
  'The dispute the warning is about. The email row points back here through reference_id.';

comment on column public.dispute_deadline_warnings.stage is
  'start or midpoint: which of section 19''s two warnings this is.';

comment on column public.dispute_deadline_warnings.window_hours is
  'The window the warning was about: 24, or 48 after a super administrator extended it.';

comment on column public.dispute_deadline_warnings.opened_at is
  'The dispute''s opening instant, copied so the row can prove its own arithmetic.';

comment on column public.dispute_deadline_warnings.warn_at is
  'The instant the warning was due: the opening for the start, the opening plus half the window for the midpoint.';

comment on column public.dispute_deadline_warnings.due_at is
  'The deadline the warning told the merchant about: the opening plus the whole window.';

comment on column public.dispute_deadline_warnings.send_id is
  'The email_send_logs row this warning was queued as. One email cannot claim two warnings.';

comment on column public.dispute_deadline_warnings.queued_at is
  'When the sweep handed the warning to the email system, which is never before it was due.';

comment on column public.dispute_deadline_warnings.created_at is
  'When the row was written.';

comment on column public.dispute_deadline_warnings.updated_at is
  'Present for shape only: no update is possible on this table.';

comment on column public.dispute_deadline_warnings.deleted_at is
  'Present for shape only: no removal is possible on this table.';

comment on column public.dispute_deadline_warnings.version is
  'Optimistic locking counter, always 1 because the guard trigger refuses every update.';

-- One warning per stage per window, however often the sweep runs.
create unique index dispute_deadline_warnings_stage_key
  on public.dispute_deadline_warnings (dispute_id, stage, window_hours);

-- The start warning happens once in a dispute's life, whatever the window became afterwards.
create unique index dispute_deadline_warnings_start_key
  on public.dispute_deadline_warnings (dispute_id)
  where stage = 'start';

-- One email cannot be the evidence of two warnings.
create unique index dispute_deadline_warnings_send_key
  on public.dispute_deadline_warnings (send_id);

-- The office read: a merchant's warnings, newest due first, which is the panel on the queue screen.
create index dispute_deadline_warnings_company_idx
  on public.dispute_deadline_warnings (company_id, warn_at desc);

create trigger dispute_deadline_warnings_guard_window
  before insert on public.dispute_deadline_warnings
  for each row
  execute function public.dispute_deadline_warnings_guard_window();

create trigger dispute_deadline_warnings_guard_append_only
  before update or delete on public.dispute_deadline_warnings
  for each row
  execute function public.dispute_deadline_warnings_guard_append_only();

alter table public.dispute_deadline_warnings enable row level security;

create policy dispute_deadline_warnings_default_deny
  on public.dispute_deadline_warnings
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
