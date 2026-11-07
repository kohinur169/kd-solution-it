-- path: migrations/0128_chargeback_actions.sql
-- STEP 199 - the chargeback rate, and the three steps the platform may take about it.
--
-- Section 18's sentence, in full: "Chargeback handling follows international card network rules: rate and
-- transaction count are both considered, a minimum transaction count must be reached before a percentage
-- threshold applies, and action is graduated: warning and monitoring, then extra reserve, then suspension.
-- Every threshold value is configurable by super_admin." The policy page of `0078` says the same thing to
-- merchants, so it is a promise and not a plan: "the platform watches the chargeback rate and the transaction
-- count together, because a percentage only means something above a minimum count."
--
-- Three things follow, and this file is where all three become checkable:
--
--   1. A measurement is a snapshot with numbers on it. An action row carries the window it measured, the
--      transactions in that window, the chargebacks in it, the rate those two give in basis points, and the
--      four thresholds the decision was taken against. Storing the thresholds beside the measurement is the
--      point: a super administrator who raises a threshold tomorrow must not rewrite the reason a merchant was
--      warned today, and an audit that reads "rate 2.41 percent" without the bar it cleared is not an audit.
--   2. The ladder is arithmetic, not opinion. `chargeback_actions_step_check` re-derives the step from the row's
--      own numbers: a `suspension` whose rate only clears the warning bar is refused by the table, so a service
--      that lied about which step it was taking cannot record the lie. The minimum transaction count is checked
--      first, because section 18 says a percentage below it means nothing.
--   3. The effect has to exist. A `reserve` row names the reserve it started, a `suspension` row names the
--      lifecycle event it wrote, and a suspension is `manual` with a named officer - a warning and a reserve are
--      the platform acting on its own, but stopping a merchant's business is a person's decision, and `0111`
--      already refuses a suspension with no actor. Nothing here invents a fifth state: the reserve is a `0044`
--      row, the suspension is an `0111` row, and the email is a `0061` row.
--
-- The one transition this table allows is the clearing of a warning or a reserve: a merchant whose rate came
-- back down must not wear a monitoring badge forever, so `cleared_at`, `cleared_by_user_id` and `clear_note`
-- move once, together, and never on a suspension - a suspended account returns through `0111`'s own
-- reactivation flow, which already records who let it back and what they were shown.
--
-- Nothing is deleted. `chargeback_actions_guard` refuses every delete and every other update, so the ladder a
-- merchant climbed stays readable after it was cleared, which is what an acquirer asks for when a chargeback
-- programme is reviewed.

begin;

create function public.chargeback_actions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  existing_kind text;
  existing_rank integer;
  new_rank integer;
  reserve_company uuid;
  reserve_status text;
  event_company uuid;
  event_name text;
  event_reason text;
  email_company uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'a chargeback action is never removed'
      using errcode = 'restrict_violation';
  end if;

  -- A rank is the same order section 18 names: a warning, then a reserve, then a suspension.
  new_rank := case new.kind when 'warning' then 1 when 'reserve' then 2 else 3 end;

  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'cleared_at' - 'cleared_by_user_id' - 'clear_note' - 'updated_at' - 'version')
       is distinct from
       (to_jsonb(old) - 'cleared_at' - 'cleared_by_user_id' - 'clear_note' - 'updated_at' - 'version') then
      raise exception 'a chargeback action keeps the measurement it was taken on'
        using errcode = 'check_violation';
    end if;

    if old.cleared_at is not null then
      raise exception 'a chargeback action is cleared once'
        using errcode = 'check_violation';
    end if;

    if new.cleared_at is null then
      raise exception 'the only change to a chargeback action is clearing it'
        using errcode = 'check_violation';
    end if;

    if new.kind = 'suspension' then
      raise exception 'a suspension is lifted by the account lifecycle, not by this table'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  if new.kind <> 'suspension' then
    select actions.kind into existing_kind
      from public.chargeback_actions as actions
     where actions.company_id = new.company_id
       and actions.kind = 'suspension'
       and actions.deleted_at is null
       and actions.cleared_at is null
     limit 1;

    if existing_kind is not null then
      raise exception 'a suspended merchant is not warned or reserved'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The ladder only moves up: a warning after a reserve would read as a slip back down the same page.
  select max(case actions.kind when 'warning' then 1 when 'reserve' then 2 else 3 end)
    into existing_rank
    from public.chargeback_actions as actions
   where actions.company_id = new.company_id
     and actions.deleted_at is null
     and actions.cleared_at is null;

  if existing_rank is not null and new_rank < existing_rank then
    raise exception 'the ladder only moves up'
      using errcode = 'check_violation';
  end if;

  if new.reserve_id is not null then
    select reserves.company_id, reserves.status
      into reserve_company, reserve_status
      from public.reserves as reserves
     where reserves.id = new.reserve_id
       and reserves.deleted_at is null;

    if reserve_company is null or reserve_company <> new.company_id then
      raise exception 'the extra reserve belongs to the merchant it was started for'
        using errcode = 'check_violation';
    end if;

    if reserve_status is null or reserve_status <> 'active' then
      raise exception 'the extra reserve is active when it is recorded'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.account_event_id is not null then
    select events.company_id, events.event, events.reason
      into event_company, event_name, event_reason
      from public.merchant_account_events as events
     where events.id = new.account_event_id;

    if event_company is null or event_company <> new.company_id then
      raise exception 'the suspension event belongs to the merchant it was written for'
        using errcode = 'check_violation';
    end if;

    if event_name <> 'suspended' or event_reason is null or event_reason <> 'chargeback_program' then
      raise exception 'a suspension step records a chargeback programme suspension'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.email_send_id is not null then
    select logs.company_id into email_company
      from public.email_send_logs as logs
     where logs.id = new.email_send_id
       and logs.deleted_at is null;

    if email_company is null or email_company <> new.company_id then
      raise exception 'the notice belongs to the merchant it was sent to'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.chargeback_actions_guard() is
  'Append only, the ladder only moves up, a suspension is a named officer and an effect, and a warning or a reserve may be cleared once.';

create table public.chargeback_actions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  kind text not null,
  mode text not null,
  window_days integer not null,
  payments_count integer not null,
  chargebacks_count integer not null,
  rate_bps integer not null,
  minimum_transactions integer not null,
  warning_rate_bps integer not null,
  reserve_rate_bps integer not null,
  suspension_rate_bps integer not null,
  reserve_percent_bps integer,
  detail text not null,
  actor_user_id uuid,
  reserve_id uuid,
  account_event_id uuid,
  email_send_id uuid,
  applied_at timestamptz not null,
  cleared_at timestamptz,
  cleared_by_user_id uuid,
  clear_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint chargeback_actions_pkey primary key (id),
  constraint chargeback_actions_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint chargeback_actions_actor_fkey foreign key (actor_user_id)
    references public.users (id),
  constraint chargeback_actions_cleared_by_fkey foreign key (cleared_by_user_id)
    references public.users (id),
  constraint chargeback_actions_reserve_fkey foreign key (reserve_id)
    references public.reserves (id),
  constraint chargeback_actions_account_event_fkey foreign key (account_event_id)
    references public.merchant_account_events (id),
  constraint chargeback_actions_email_fkey foreign key (email_send_id)
    references public.email_send_logs (id),
  constraint chargeback_actions_kind_check check (kind in ('warning', 'reserve', 'suspension')),
  constraint chargeback_actions_mode_check check (mode in ('automatic', 'manual')),
  constraint chargeback_actions_window_check check (window_days between 1 and 365),
  constraint chargeback_actions_counts_check check (
    payments_count >= 0
    and chargebacks_count >= 0
    and minimum_transactions between 0 and 1000000
    and window_days >= 1
  ),
  constraint chargeback_actions_rate_check check (
    rate_bps between 0 and 10000
    and (
      (payments_count = 0 and rate_bps = 0 and chargebacks_count = 0)
      or (
        payments_count > 0
        and abs((rate_bps::bigint * payments_count::bigint) - (chargebacks_count::bigint * 10000)) <= payments_count
      )
    )
  ),
  constraint chargeback_actions_thresholds_check check (
    warning_rate_bps between 1 and 10000
    and reserve_rate_bps between 1 and 10000
    and suspension_rate_bps between 1 and 10000
    and warning_rate_bps <= reserve_rate_bps
    and reserve_rate_bps <= suspension_rate_bps
  ),
  constraint chargeback_actions_step_check check (
    payments_count >= minimum_transactions
    and case kind
      when 'warning' then rate_bps >= warning_rate_bps
      when 'reserve' then rate_bps >= reserve_rate_bps
      else rate_bps >= suspension_rate_bps
    end
  ),
  constraint chargeback_actions_reserve_percent_check check (
    reserve_percent_bps is null or reserve_percent_bps between 0 and 10000
  ),
  constraint chargeback_actions_effect_check check (
    (kind = 'reserve') = (reserve_id is not null)
    and (kind = 'suspension') = (account_event_id is not null)
    and (kind = 'suspension') = (mode = 'manual')
  ),
  constraint chargeback_actions_actor_check check ((mode = 'manual') = (actor_user_id is not null)),
  constraint chargeback_actions_detail_check check (
    char_length(detail) between 1 and 280
    and detail = btrim(detail)
  ),
  constraint chargeback_actions_cleared_check check (
    (cleared_at is null) = (cleared_by_user_id is null)
    and (cleared_at is null) = (clear_note is null)
    and (clear_note is null or (char_length(clear_note) between 1 and 280 and clear_note = btrim(clear_note)))
  ),
  constraint chargeback_actions_clear_order_check check (
    cleared_at is null or cleared_at >= applied_at
  ),
  constraint chargeback_actions_row_version_check check (version > 0),
  constraint chargeback_actions_updated_check check (updated_at >= created_at),
  constraint chargeback_actions_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.chargeback_actions is
  'The chargeback-rate ladder of one merchant: what was measured, which step it earned and what the step did.';

comment on column public.chargeback_actions.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.chargeback_actions.company_id is
  'The merchant the measurement is about. Frozen after the row is written.';

comment on column public.chargeback_actions.kind is
  'warning, reserve or suspension: the graduated action of section 18, in the order it is climbed.';

comment on column public.chargeback_actions.mode is
  'automatic when the platform acted on its own clock, manual when a named officer did. A suspension is always manual.';

comment on column public.chargeback_actions.window_days is
  'The rolling window the measurement covers, in days, as the policy set it.';

comment on column public.chargeback_actions.payments_count is
  'The transactions captured for this merchant inside the window: the denominator section 18 counts.';

comment on column public.chargeback_actions.chargebacks_count is
  'The disputes opened against this merchant inside the window.';

comment on column public.chargeback_actions.rate_bps is
  'The rate those two give in basis points, so 241 means 2.41 percent. Never a float.';

comment on column public.chargeback_actions.minimum_transactions is
  'The minimum transaction count the policy required before any percentage applied.';

comment on column public.chargeback_actions.warning_rate_bps is
  'The warning threshold the decision was taken against, copied so a later policy change does not rewrite it.';

comment on column public.chargeback_actions.reserve_rate_bps is
  'The extra-reserve threshold the decision was taken against.';

comment on column public.chargeback_actions.suspension_rate_bps is
  'The suspension threshold the decision was taken against.';

comment on column public.chargeback_actions.reserve_percent_bps is
  'The percent the extra reserve was started at, in basis points. Only on a reserve step.';

comment on column public.chargeback_actions.detail is
  'The sentence the office reads: what was measured and why the step followed. Trimmed, at most 280 characters.';

comment on column public.chargeback_actions.actor_user_id is
  'The officer who took a manual step. Null on the automatic steps, exactly as the mode says.';

comment on column public.chargeback_actions.reserve_id is
  'The `0044` reserve this step started. Present exactly on a reserve step.';

comment on column public.chargeback_actions.account_event_id is
  'The `0111` suspension this step wrote. Present exactly on a suspension step.';

comment on column public.chargeback_actions.email_send_id is
  'The `0061` notice queued for the merchant, when there was an address and a sender to queue it for.';

comment on column public.chargeback_actions.applied_at is
  'When the platform took the step, which is when the merchant was told or the reserve began.';

comment on column public.chargeback_actions.cleared_at is
  'When a warning or a reserve was lifted, after the rate came back down. Never set on a suspension.';

comment on column public.chargeback_actions.cleared_by_user_id is
  'The super administrator who lifted it. Null exactly when `cleared_at` is null.';

comment on column public.chargeback_actions.clear_note is
  'Why it was lifted, at most 280 characters and trimmed.';

comment on column public.chargeback_actions.created_at is
  'When the row was written.';

comment on column public.chargeback_actions.updated_at is
  'Maintained by public.set_row_metadata() on the one update this table allows.';

comment on column public.chargeback_actions.deleted_at is
  'Soft delete marker, refused by the guard: an action is never removed.';

comment on column public.chargeback_actions.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One step of each kind per merchant, and only while it is live.
create unique index chargeback_actions_live_key
  on public.chargeback_actions (company_id, kind)
  where deleted_at is null;

-- The office's read: one merchant's ladder, newest first.
create index chargeback_actions_company_idx
  on public.chargeback_actions (company_id, applied_at desc);

-- The watchlist's read: every live action, so a merchant already suspended is not measured again.
create index chargeback_actions_open_idx
  on public.chargeback_actions (kind, applied_at desc)
  where deleted_at is null and cleared_at is null;

create trigger chargeback_actions_guard
  before insert or update or delete on public.chargeback_actions
  for each row
  execute function public.chargeback_actions_guard();

create trigger chargeback_actions_set_row_metadata
  before update on public.chargeback_actions
  for each row
  execute function public.set_row_metadata();

alter table public.chargeback_actions enable row level security;

create policy chargeback_actions_default_deny
  on public.chargeback_actions
  for all
  to public
  using (false)
  with check (false);

commit;
