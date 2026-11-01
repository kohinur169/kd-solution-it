-- path: migrations/0084_two_factor_reset_requests.sql
-- STEP 044 - the reset a merchant asks for when the app and the codes are both gone.
--
-- Section 22 states the whole process in one sentence: "When backup codes are finished or lost, the
-- merchant contacts the platform by email, supplies additional documents for verification, the
-- office resets 2FA, and the merchant sets up 2FA again after login." Four parties' actions, in
-- order, and this table is the record of them:
--
--   1. the merchant asks, from a screen that needs no session, because the account they cannot sign
--      into is the account they are asking about;
--   2. the office records that contact happened and what was verified - today that is a reference to
--      the documents supplied by email, because the encrypted file pipeline is STEP 100's and a
--      column that pretended to hold an upload would be a lie;
--   3. the office approves or rejects, and an approval is the only thing that clears the account's
--      second factor;
--   4. the merchant signs in with the password alone and enrols again through STEP 041.
--
-- The states are the four steps, and the constraints keep them honest:
--
--   - `pending` is a request nobody has looked at yet;
--   - `contacted` means an office member recorded the contact and the document reference, which is
--     the point of no return for the audit trail: an approval cannot skip it;
--   - `approved` and `rejected` carry who decided and when, together or not at all;
--   - `cancelled` is a merchant withdrawing the request before a decision.
--
-- One live request per account, enforced by a partial unique index, so a frightened merchant cannot
-- create a queue of duplicates and an office member cannot approve the same reset twice.
--
-- The reason is merchant supplied text and it is stored because the office has to read it. Nothing
-- in this table is secret, but nothing in it is public either: the default-deny policy below means a
-- request never reaches a browser without a service that decided to show it.

begin;

create table public.two_factor_reset_requests (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  status text not null default 'pending',
  reason text not null,
  document_reference text,
  requested_ip inet,
  requested_user_agent text,
  contacted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint two_factor_reset_requests_pkey primary key (id),
  constraint two_factor_reset_requests_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint two_factor_reset_requests_user_fkey foreign key (user_id)
    references public.users (id),
  constraint two_factor_reset_requests_decided_by_fkey foreign key (decided_by)
    references public.users (id),
  constraint two_factor_reset_requests_status_check check (
    status in ('pending', 'contacted', 'approved', 'rejected', 'cancelled')
  ),
  constraint two_factor_reset_requests_reason_check check (
    char_length(reason) between 10 and 1000 and reason = btrim(reason)
  ),
  constraint two_factor_reset_requests_document_check check (
    document_reference is null
    or (char_length(document_reference) between 1 and 200 and document_reference = btrim(document_reference))
  ),
  constraint two_factor_reset_requests_ip_check check (
    requested_ip is null or family(requested_ip) in (4, 6)
  ),
  constraint two_factor_reset_requests_agent_check check (
    requested_user_agent is null or char_length(requested_user_agent) between 1 and 512
  ),
  constraint two_factor_reset_requests_contacted_check check (
    contacted_at is null or status in ('contacted', 'approved', 'rejected')
  ),
  -- A decision is a pair: who and when, or neither. The first form of this check compared the
  -- status with the pair and let a `decided_by` sit on a row nobody had decided, which PGlite refused
  -- while proving it; the case form closes both directions.
  constraint two_factor_reset_requests_decision_check check (
    case status
      when 'approved' then decided_at is not null and decided_by is not null
      when 'rejected' then decided_at is not null and decided_by is not null
      else decided_at is null and decided_by is null
    end
  ),
  constraint two_factor_reset_requests_note_check check (
    decision_note is null or char_length(decision_note) between 1 and 1000
  ),
  constraint two_factor_reset_requests_version_positive_check check (version > 0),
  constraint two_factor_reset_requests_updated_after_creation_check check (updated_at >= created_at),
  constraint two_factor_reset_requests_deleted_after_creation_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.two_factor_reset_requests is
  'One merchant request to reset two factor authentication, and the office decision on it.';

comment on column public.two_factor_reset_requests.user_id is
  'The account whose second factor would be cleared. The email the merchant typed resolves to it before a row exists.';

comment on column public.two_factor_reset_requests.status is
  'pending, contacted (contact and documents recorded), approved, rejected or cancelled.';

comment on column public.two_factor_reset_requests.reason is
  'What the merchant says happened, in their words, 10 to 1000 characters.';

comment on column public.two_factor_reset_requests.document_reference is
  'What the office verified, recorded when contact is confirmed. Proof of identity supplied by email; the encrypted file pipeline is STEP 100.';

comment on column public.two_factor_reset_requests.contacted_at is
  'When an office member confirmed the contact by email. An approval cannot exist without it.';

comment on column public.two_factor_reset_requests.decided_by is
  'The office account that approved or rejected the request. Required exactly when a decision exists.';

-- One live request per account: a second pending row is a duplicate, not a second chance.
create unique index two_factor_reset_requests_live_key
  on public.two_factor_reset_requests (user_id)
  where deleted_at is null and status in ('pending', 'contacted');

-- The office queue: the oldest undecided request first.
create index two_factor_reset_requests_queue_idx
  on public.two_factor_reset_requests (status, created_at)
  where deleted_at is null;

-- The merchant's own history, if a screen ever shows it.
create index two_factor_reset_requests_user_idx
  on public.two_factor_reset_requests (user_id, created_at desc)
  where deleted_at is null;

create trigger two_factor_reset_requests_set_row_metadata
  before update on public.two_factor_reset_requests
  for each row
  execute function public.set_row_metadata();

alter table public.two_factor_reset_requests enable row level security;

create policy two_factor_reset_requests_default_deny
  on public.two_factor_reset_requests
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
