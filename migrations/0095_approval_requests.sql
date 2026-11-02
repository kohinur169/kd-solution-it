-- path: migrations/0095_approval_requests.sql
-- STEP 070 - the approval chain of section 2, as a queue the CEO can see.
--
-- Section 2 states the chain in one line: "requester, then CEO, then super_admin". Section 2 also
-- names the decisions the CEO makes and section 6 the one the super administrator needs a second
-- signature for, so the four actions this table carries are exactly the four the later STEP 072
-- confirms:
--
--   - `payout_release` - a large payout the finance team may not release alone;
--   - `reserve_release` - a reserve the platform may not return without a second signature;
--   - `platform_fee_change` - the platform's own fee, which nobody may change unilaterally;
--   - `country_enable` - the platform country switch of section 36, which the super administrator
--     and the CEO decide together.
--
-- ## Why a table and not a flag on each of the four
--
-- The four live in four tables with four shapes, and the question a home page answers - "what is
-- waiting for me, in what order, for how long" - is one query over one shape. A table per subject
-- would have made the CEO's queue a union of four reads and four permission checks, and the second
-- one to be written would have been the one that forgot a check. The queue is therefore one row per
-- request, with the subject named by a type and an identifier and described by a label a person can
-- read without a join.
--
-- ## The state machine
--
--   - `pending_ceo`: raised, nothing decided. Every row starts here.
--   - `pending_super_admin`: the CEO approved, and the chain's last signature is still missing.
--   - `approved`: both signatures are on the row. This is the only state a subject may be changed in.
--   - `rejected`: the CEO said no. A rejection is final; a new attempt is a new request.
--   - `cancelled`: the requester withdrew it before a decision.
--   - `expired`: nobody decided inside the window. Expiry is a state, not a deletion, so the queue
--     keeps the evidence that attention was missing.
--
-- ## What the constraints keep honest
--
--   - an action type names exactly one subject type, so a payout release can never point at a plan;
--   - a decision is a pair (who and when) or neither, in both directions;
--   - `pending_super_admin` cannot exist without a CEO signature, and `approved` cannot exist
--     without both;
--   - a request expires after it was raised;
--   - money is a pair: an amount and the currency it is in, or neither, and never zero;
--   - one live request per (action type, subject), enforced by a partial unique index, so the queue
--     cannot fill with duplicates of the same decision and the same subject cannot be released twice.
--
-- The table is default-deny: no browser role can read it, and every read and write goes through
-- `lib/approvals/service.ts` with the service role key, which is where the role matrix and the
-- freshness of the second factor are enforced. Nothing here is secret, but a queue of money
-- decisions is not something a browser query should be able to enumerate either.

begin;

create table public.approval_requests (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  action_type text not null,
  subject_type text not null,
  subject_id uuid not null,
  subject_label text not null,
  amount_minor bigint,
  currency text,
  request_note text not null,
  requested_by uuid not null,
  requested_by_role text not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending_ceo',
  ceo_decided_by uuid,
  ceo_decided_at timestamptz,
  ceo_note text,
  super_admin_confirmed_by uuid,
  super_admin_confirmed_at timestamptz,
  super_admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint approval_requests_pkey primary key (id),
  constraint approval_requests_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint approval_requests_requested_by_fkey foreign key (requested_by)
    references public.users (id),
  constraint approval_requests_ceo_decided_by_fkey foreign key (ceo_decided_by)
    references public.users (id),
  constraint approval_requests_super_admin_by_fkey foreign key (super_admin_confirmed_by)
    references public.users (id),
  constraint approval_requests_action_check check (
    action_type in ('payout_release', 'reserve_release', 'platform_fee_change', 'country_enable')
  ),
  constraint approval_requests_subject_check check (
    (action_type = 'payout_release' and subject_type = 'payout')
    or (action_type = 'reserve_release' and subject_type = 'reserve')
    or (action_type = 'platform_fee_change' and subject_type = 'plan')
    or (action_type = 'country_enable' and subject_type = 'country')
  ),
  constraint approval_requests_label_check check (
    char_length(subject_label) between 1 and 160 and subject_label = btrim(subject_label)
  ),
  constraint approval_requests_note_check check (
    char_length(request_note) between 10 and 1000 and request_note = btrim(request_note)
  ),
  constraint approval_requests_amount_check check (
    (amount_minor is null) = (currency is null)
    and (amount_minor is null or amount_minor > 0)
    and (currency is null or currency ~ '^[A-Z]{3}$')
  ),
  constraint approval_requests_role_check check (
    requested_by_role in
      ('super_admin', 'ceo', 'compliance_kyc', 'finance_ops', 'support', 'blogger')
  ),
  constraint approval_requests_expiry_check check (expires_at > requested_at),
  constraint approval_requests_status_check check (
    status in ('pending_ceo', 'pending_super_admin', 'approved', 'rejected', 'cancelled', 'expired')
  ),
  constraint approval_requests_ceo_check check (
    (ceo_decided_at is null) = (ceo_decided_by is null)
    and (status <> 'pending_ceo' or ceo_decided_at is null)
    and (status not in ('pending_super_admin', 'approved', 'rejected') or ceo_decided_at is not null)
  ),
  constraint approval_requests_super_admin_check check (
    (super_admin_confirmed_at is null) = (super_admin_confirmed_by is null)
    and (status <> 'approved' or super_admin_confirmed_at is not null)
  ),
  constraint approval_requests_ceo_note_check check (
    ceo_note is null or char_length(ceo_note) between 1 and 1000
  ),
  constraint approval_requests_super_admin_note_check check (
    super_admin_note is null or char_length(super_admin_note) between 1 and 1000
  ),
  constraint approval_requests_version_check check (version > 0),
  constraint approval_requests_updated_check check (updated_at >= created_at),
  constraint approval_requests_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.approval_requests is
  'One large action waiting on the section 2 chain: the requester, then the CEO, then the super administrator.';

comment on column public.approval_requests.company_id is
  'The merchant the request is about, or null when the subject belongs to the platform itself.';

comment on column public.approval_requests.action_type is
  'payout_release, reserve_release, platform_fee_change or country_enable: the four section 2 and 6 actions.';

comment on column public.approval_requests.subject_type is
  'The table the subject lives in. Fixed per action type, so a payout release cannot point at a plan.';

comment on column public.approval_requests.subject_id is
  'The row the action would change. Not a foreign key, because the subject is one of four tables.';

comment on column public.approval_requests.subject_label is
  'What the CEO reads in the queue, written by the requester, 1 to 160 characters.';

comment on column public.approval_requests.amount_minor is
  'The money the decision is about, in the currency minor unit, or null when the action moves no money.';

comment on column public.approval_requests.request_note is
  'Why the requester asks, in their words, 10 to 1000 characters. The CEO reads this before deciding.';

comment on column public.approval_requests.requested_by_role is
  'The office role the requester acted with, recorded beside the account because a role can change later.';

comment on column public.approval_requests.expires_at is
  'When the request stops waiting. Expiry is a status, so the queue keeps the record of a missed decision.';

comment on column public.approval_requests.status is
  'pending_ceo, pending_super_admin, approved, rejected, cancelled or expired.';

comment on column public.approval_requests.ceo_decided_by is
  'The CEO who decided, required exactly when a CEO decision exists.';

comment on column public.approval_requests.super_admin_confirmed_by is
  'The super administrator who signed last, required exactly when the request is approved.';

-- One live request per action and subject: the same decision cannot be queued twice.
create unique index approval_requests_live_key
  on public.approval_requests (action_type, subject_id)
  where deleted_at is null and status in ('pending_ceo', 'pending_super_admin');

-- The queue itself: what is waiting, oldest first.
create index approval_requests_queue_idx
  on public.approval_requests (status, requested_at)
  where deleted_at is null;

-- The requester's own history.
create index approval_requests_requester_idx
  on public.approval_requests (requested_by, requested_at desc)
  where deleted_at is null;

create trigger approval_requests_set_row_metadata
  before update on public.approval_requests
  for each row
  execute function public.set_row_metadata();

alter table public.approval_requests enable row level security;

create policy approval_requests_default_deny
  on public.approval_requests
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
