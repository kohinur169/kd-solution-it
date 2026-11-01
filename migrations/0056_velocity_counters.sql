-- path: migrations/0056_velocity_counters.sql
-- STEP 030 - the card and IP velocity counters of section 18.
--
-- Section 18: "Card and IP velocity limits exist with defaults in config." The defaults live in
-- `config/`, so this table never guesses a number: `limit_value` is the limit the enforcement
-- applied at that moment and it is required. Recording it beside the count is what lets an
-- investigation say which limit was breached after a setting changed.
--
-- A counter is one subject and one window. Exactly one of `card_fingerprint` and `ip_address` is
-- set, which `num_nonnulls(...) = 1` enforces, so a card counter and an IP counter are two shapes
-- of the same row and never a confused third. `ip_address` is a real `inet`, so a range question
-- stays a range question, and the card side is the same 64 hex fingerprint the blacklist uses.
--
-- `window_start` and `window_seconds` name the window, and the partial unique keys over the
-- subject and the window mean a second hit cannot create a second counter for the same card or IP
-- in the same window. `hit_count` counts inside the window, `exceeded_at` records the first
-- breach, and `last_hit_at` records the last hit.
--
-- `velocity_counters_guard_count` keeps the row honest: the subject, the window and the limit are
-- frozen, the count only rises, the breach is written once and never cleared, the last hit moves
-- forward, and the row is never soft deleted. A counter that could shrink or disappear would erase
-- the evidence the payment page acted on, and a deleted counter would also free its window key for
-- a fresh count of zero, which is the limit bypassed. Retention of old windows is therefore a
-- physical delete by the sweep in STEP 067, not a soft delete here.

begin;

create function public.velocity_counters_guard_count()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'a velocity counter is never deleted, only retired by the sweep'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from old.company_id
     or new.card_fingerprint is distinct from old.card_fingerprint
     or new.ip_address is distinct from old.ip_address
     or new.window_start is distinct from old.window_start
     or new.window_seconds is distinct from old.window_seconds
     or new.limit_value is distinct from old.limit_value then
    raise exception 'a velocity counter keeps its subject, its window and its limit'
      using errcode = 'check_violation';
  end if;

  if new.hit_count < old.hit_count then
    raise exception 'a velocity counter only counts up'
      using errcode = 'check_violation';
  end if;

  if old.exceeded_at is not null and new.exceeded_at is distinct from old.exceeded_at then
    raise exception 'a velocity breach is recorded once and never cleared'
      using errcode = 'check_violation';
  end if;

  if new.last_hit_at < old.last_hit_at then
    raise exception 'the last hit of a velocity counter moves forward only'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.velocity_counters_guard_count() is
  'Freezes the subject, the window and the limit, counts up only, never clears a breach and refuses a delete.';

create table public.velocity_counters (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  card_fingerprint text,
  ip_address inet,
  window_start timestamptz not null,
  window_seconds integer not null,
  hit_count integer not null default 0,
  limit_value integer not null,
  exceeded_at timestamptz,
  last_hit_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint velocity_counters_pkey primary key (id),
  constraint velocity_counters_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint velocity_counters_platform_check check (company_id is null),
  constraint velocity_counters_subject_check check (
    num_nonnulls(card_fingerprint, ip_address) = 1
  ),
  constraint velocity_counters_fingerprint_check check (
    card_fingerprint is null or card_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint velocity_counters_window_check check (
    window_seconds between 1 and 2592000
  ),
  constraint velocity_counters_count_check check (hit_count >= 0),
  constraint velocity_counters_limit_check check (limit_value >= 1),
  constraint velocity_counters_exceeded_check check (
    exceeded_at is null
    or (hit_count >= limit_value and exceeded_at >= window_start)
  ),
  constraint velocity_counters_start_check check (window_start <= created_at),
  constraint velocity_counters_hit_order_check check (last_hit_at >= window_start),
  constraint velocity_counters_row_version_check check (version > 0),
  constraint velocity_counters_updated_check check (updated_at >= created_at),
  constraint velocity_counters_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.velocity_counters is
  'One card or IP counter for one window, with the limit that applied and the instant it was hit.';

comment on column public.velocity_counters.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.velocity_counters.company_id is
  'Always null: velocity is counted for the platform, and the column exists for the tenancy rule.';

comment on column public.velocity_counters.card_fingerprint is
  'SHA-256 of the card token or provider fingerprint, set on a card counter and null on an IP one.';

comment on column public.velocity_counters.ip_address is
  'The payer address of an IP counter, set on an IP counter and null on a card one.';

comment on column public.velocity_counters.window_start is
  'The first instant of the window, never after the row that records it.';

comment on column public.velocity_counters.window_seconds is
  'The length of the window in seconds, from one second to thirty days.';

comment on column public.velocity_counters.hit_count is
  'How many hits fell inside the window.';

comment on column public.velocity_counters.limit_value is
  'The configured limit the enforcement applied, so a later change of setting cannot rewrite it.';

comment on column public.velocity_counters.exceeded_at is
  'The instant the count first reached the limit, written once and never cleared.';

comment on column public.velocity_counters.last_hit_at is
  'The instant of the last hit inside the window, which only moves forward.';

comment on column public.velocity_counters.created_at is
  'When the row was written.';

comment on column public.velocity_counters.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.velocity_counters.deleted_at is
  'Soft delete marker, frozen by the guard because a window is retired by a physical delete.';

comment on column public.velocity_counters.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One counter per card, window start and window length.
create unique index velocity_counters_card_key
  on public.velocity_counters (card_fingerprint, window_start, window_seconds)
  where card_fingerprint is not null and deleted_at is null;

-- One counter per address, window start and window length.
create unique index velocity_counters_ip_key
  on public.velocity_counters (ip_address, window_start, window_seconds)
  where ip_address is not null and deleted_at is null;

-- The sweep that retires windows older than the retention of the settings, with a physical delete:
-- a counter is never soft deleted, because a hidden counter would free its window for a new count.
create index velocity_counters_sweep_idx
  on public.velocity_counters (window_start)
  where deleted_at is null;

create trigger velocity_counters_guard_count
  before update on public.velocity_counters
  for each row
  execute function public.velocity_counters_guard_count();

create trigger velocity_counters_set_row_metadata
  before update on public.velocity_counters
  for each row
  execute function public.set_row_metadata();

alter table public.velocity_counters enable row level security;

create policy velocity_counters_default_deny
  on public.velocity_counters
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
