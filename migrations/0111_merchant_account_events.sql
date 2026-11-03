-- path: migrations/0111_merchant_account_events.sql
-- STEP 099 - the merchant account lifecycle of FEATURE_LIST section 13: suspension, reactivation
-- and closure.
--
-- Section 13: "A suspended merchant submits the required documents and returns to active status
-- after compliance review. When a merchant closes the account, remaining money is sent to the bank
-- after the hold period, and funds for possible chargeback liability stay held until the chargeback
-- period ends. When a merchant leaves the platform, saved card tokens are deleted at once. Closed
-- and suspended account data and sub-merchant records are retained for 7 years for regulatory
-- observation."
--
-- This file is the event log those rules write to. It is insert-only by guard: one row per lifecycle
-- event of one merchant, never updated and never deleted, which is what the 7 year retention asks
-- for - a closed account's rows stay readable and are never rewritten.
--
--   1. `event` is the closed vocabulary: `suspended` (with a `reason` from the closed list and the
--      `required_documents` the compliance desk asks for), `reactivation_requested` (the merchant
--      answered with the named `kyc_submission_id`), `reactivated` (the compliance review accepted
--      it), `closure_requested` (the merchant asked to close), `closed` (the office closed it, with
--      the verified `payout_bank_account_id`, the `hold_release_at` after which the remaining money
--      goes to that bank, and the `chargeback_hold_release_at` until which the chargeback liability
--      funds stay held), and `card_tokens_deleted` (the saved card tokens of the sub-merchant were
--      deleted at the provider; actor null, it is a system event).
--   2. The checks keep every event honest: the reason only on a suspension, the submission only on a
--      reactivation request, the payout and the two release instants only on a closure, and the
--      closure's chargeback instant strictly after its payout instant and both after the row's own
--      creation.
--   3. The current state of a merchant is the latest of the five state bearing events (the token
--      deletion event does not change it); the service derives it, this file just stores the facts.
--   4. The seed at the bottom is the chargeback period itself: `chargeback.hold_days` in
--      `platform_settings`, 180 days, the card network chargeback window, changeable by super_admin
--      through the settings screen of the settings block. The closure flow reads it; a platform
--      setting is data, and this file only seeds the default.
--
-- RLS is default-deny; the app reads and writes through the PostgREST service role key.

begin;

create function public.merchant_account_events_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a merchant account event is retained history, never removed'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'a merchant account event is never rewritten or soft deleted'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function public.merchant_account_events_guard_state() is
  'Refuses every update, delete and soft delete: the lifecycle log is append only.';

create table public.merchant_account_events (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  event text not null,
  reason text,
  detail text,
  required_documents jsonb,
  actor_user_id uuid,
  kyc_submission_id uuid,
  payout_bank_account_id uuid,
  hold_release_at timestamptz,
  chargeback_hold_release_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint merchant_account_events_pkey primary key (id),
  constraint merchant_account_events_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint merchant_account_events_actor_fkey foreign key (actor_user_id)
    references public.users (id),
  constraint merchant_account_events_submission_fkey foreign key (kyc_submission_id, company_id)
    references public.kyc_submissions (id, company_id),
  constraint merchant_account_events_bank_account_fkey foreign key (payout_bank_account_id)
    references public.payout_bank_accounts (id),
  constraint merchant_account_events_event_check check (
    event in ('suspended', 'reactivation_requested', 'reactivated', 'closure_requested', 'closed',
              'card_tokens_deleted')
  ),
  constraint merchant_account_events_reason_check check (
    (event = 'suspended') = (reason is not null)
    and (
      reason is null
      or reason in ('risk', 'chargeback_program', 'billing', 'manual')
    )
  ),
  constraint merchant_account_events_detail_check check (
    detail is null or (char_length(detail) between 1 and 280 and detail = btrim(detail))
  ),
  constraint merchant_account_events_documents_check check (
    (event = 'suspended') = (required_documents is not null)
    and (
      required_documents is null
      or (
        jsonb_typeof(required_documents) = 'array'
        and jsonb_array_length(required_documents) between 0 and 10
      )
    )
  ),
  constraint merchant_account_events_actor_check check (
    (event = 'card_tokens_deleted') = (actor_user_id is null)
  ),
  constraint merchant_account_events_submission_check check (
    (event = 'reactivation_requested') = (kyc_submission_id is not null)
  ),
  constraint merchant_account_events_closure_check check (
    (event = 'closed') = (
      payout_bank_account_id is not null
      and hold_release_at is not null
      and chargeback_hold_release_at is not null
    )
  ),
  constraint merchant_account_events_closure_order_check check (
    hold_release_at is null
    or (hold_release_at > created_at and chargeback_hold_release_at > hold_release_at)
  ),
  constraint merchant_account_events_row_version_check check (version > 0),
  constraint merchant_account_events_updated_check check (updated_at >= created_at),
  constraint merchant_account_events_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.merchant_account_events is
  'One lifecycle event of one merchant account: suspension, reactivation, closure, token deletion. Append only.';

comment on column public.merchant_account_events.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.merchant_account_events.company_id is
  'The merchant whose account the event belongs to. Frozen.';

comment on column public.merchant_account_events.event is
  'suspended, reactivation_requested, reactivated, closure_requested, closed or card_tokens_deleted.';

comment on column public.merchant_account_events.reason is
  'Why the account was suspended: risk, chargeback_program, billing or manual. Only on a suspension.';

comment on column public.merchant_account_events.detail is
  'Free text of the event, at most 280 characters and trimmed: the merchant''s closure note.';

comment on column public.merchant_account_events.required_documents is
  'The documents the compliance desk requires before reactivation, as a JSON array of labels. Only on a suspension.';

comment on column public.merchant_account_events.actor_user_id is
  'Who caused the event. Null only for the system card_tokens_deleted event.';

comment on column public.merchant_account_events.kyc_submission_id is
  'The submission the merchant answered a suspension with. Only on a reactivation request.';

comment on column public.merchant_account_events.payout_bank_account_id is
  'The verified bank account the remaining money is paid to at closure. Only on a closure.';

comment on column public.merchant_account_events.hold_release_at is
  'After the merchant''s hold period ends, the remaining money is sent to the bank. Only on a closure.';

comment on column public.merchant_account_events.chargeback_hold_release_at is
  'Until the chargeback period ends, the chargeback liability funds stay held. Only on a closure.';

comment on column public.merchant_account_events.created_at is
  'When the event happened.';

comment on column public.merchant_account_events.updated_at is
  'Never moved: the guard refuses every update, so it stays at creation.';

comment on column public.merchant_account_events.deleted_at is
  'Never set: the guard refuses the soft delete. The row is retained for the 7 year observation period.';

comment on column public.merchant_account_events.version is
  'Always 1: the row is never edited, so the optimistic locking counter never moves.';

-- One merchant's own lifecycle history, newest first.
create index merchant_account_events_company_idx
  on public.merchant_account_events (company_id, created_at desc)
  where deleted_at is null;

-- The office queue: every account in an open state (suspended, reactivation or closure pending),
-- oldest first.
create index merchant_account_events_open_idx
  on public.merchant_account_events (created_at desc)
  where event in ('suspended', 'reactivation_requested', 'closure_requested')
    and deleted_at is null;

create trigger merchant_account_events_guard_state
  before insert or update or delete on public.merchant_account_events
  for each row
  execute function public.merchant_account_events_guard_state();

alter table public.merchant_account_events enable row level security;

create policy merchant_account_events_default_deny
  on public.merchant_account_events
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The chargeback period of section 13, as a platform setting super_admin can change on the settings
-- screen: the default is the 180 day card network chargeback window.
insert into public.platform_settings (setting_key, value, is_secret)
values ('chargeback.hold_days', '180'::jsonb, false);

commit;
