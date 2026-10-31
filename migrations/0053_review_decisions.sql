-- path: migrations/0053_review_decisions.sql
-- STEP 028 - the audit record of every KYC decision, section 5.
--
-- Section 5 says every KYC decision is audit logged, and section 3 gives the merchant "human
-- review and appeal path". This table is both: one row names what was decided, by whom, when and
-- why, and an appeal is a second row that points at the decision it appeals. `appeal_of_id` is a
-- foreign key into this same table on the tenant key, so an appeal cannot name a decision of
-- another merchant and cannot name itself.
--
-- The decision vocabulary is `approve`, `reject`, `request_documents`, `escalate`, `overturn` and
-- `uphold`; the last two are only legal on an appeal, which one check enforces. A rejection, a
-- document request, an escalation and an overturn each carry their reason because the merchant
-- reads it.
--
-- `appeal_state` is the state of the appeal that names this decision: `none` while nothing appeals
-- it, then `open`, `upheld` or `overturned`. The row that is itself an appeal keeps `none`, so the
-- state of a decision is read in one column and the chain is read through `appeal_of_id`.
--
-- The table is append only in the strong sense: `review_decisions_guard_state` refuses every change
-- to a recorded decision, its person, its instant, its reason and its subject, and it moves
-- `appeal_state` forward only, `none` then `open` then `upheld` or `overturned`. A correction is a
-- new row, which is what an audit reads.

begin;

create function public.review_decisions_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.subject_kind is distinct from old.subject_kind
     or new.subject_id is distinct from old.subject_id
     or new.decision is distinct from old.decision
     or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at
     or new.reason is distinct from old.reason
     or new.appeal_of_id is distinct from old.appeal_of_id
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'a review decision is history'
      using errcode = 'check_violation';
  end if;

  if old.appeal_state <> 'none'
     and new.appeal_state is distinct from old.appeal_state
     and not (old.appeal_state = 'open' and new.appeal_state in ('upheld', 'overturned')) then
    raise exception 'an appeal once recorded moves to upheld or overturned and no further'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.review_decisions_guard_state() is
  'Freezes a recorded decision and moves the state of its appeal forward only.';

create table public.review_decisions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  subject_kind text not null,
  subject_id uuid not null,
  decision text not null,
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  reason text,
  appeal_of_id uuid,
  appeal_state text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint review_decisions_pkey primary key (id),
  constraint review_decisions_tenant_key unique (id, company_id),
  constraint review_decisions_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint review_decisions_decided_by_fkey foreign key (decided_by)
    references public.users (id),
  constraint review_decisions_appeal_fkey foreign key (appeal_of_id, company_id)
    references public.review_decisions (id, company_id),
  constraint review_decisions_subject_kind_check check (
    subject_kind in ('kyc_submission', 'kyc_document', 'sanctions_screening',
                     'policy_acceptance')
  ),
  constraint review_decisions_decision_check check (
    decision in ('approve', 'reject', 'request_documents', 'escalate', 'overturn', 'uphold')
  ),
  constraint review_decisions_appeal_state_check check (
    appeal_state in ('none', 'open', 'upheld', 'overturned')
  ),
  constraint review_decisions_appeal_link_check check (
    appeal_of_id is null or (appeal_of_id <> id and appeal_state = 'none')
  ),
  constraint review_decisions_appeal_decision_check check (
    decision not in ('overturn', 'uphold') or appeal_of_id is not null
  ),
  constraint review_decisions_reason_check check (
    (decision not in ('reject', 'request_documents', 'escalate', 'overturn')
     or reason is not null)
    and (
      reason is null
      or (
        char_length(reason) between 1 and 500
        and reason = btrim(reason)
      )
    )
  ),
  constraint review_decisions_instant_check check (decided_at <= created_at),
  constraint review_decisions_row_version_check check (version > 0),
  constraint review_decisions_updated_check check (updated_at >= created_at),
  constraint review_decisions_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.review_decisions is
  'One recorded decision about one subject, with its person, its instant, its reason and its appeal.';

comment on column public.review_decisions.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.review_decisions.company_id is
  'The merchant the decision concerns. Frozen after the row is written.';

comment on column public.review_decisions.subject_kind is
  'kyc_submission, kyc_document, sanctions_screening or policy_acceptance.';

comment on column public.review_decisions.subject_id is
  'The id of the subject in the table named by subject_kind. Checked by the service that writes it.';

comment on column public.review_decisions.decision is
  'approve, reject, request_documents, escalate, overturn or uphold.';

comment on column public.review_decisions.decided_by is
  'The person who decided.';

comment on column public.review_decisions.decided_at is
  'When the decision was made. Never after the row that records it.';

comment on column public.review_decisions.reason is
  'Why, required on a rejection, a document request, an escalation and an overturn.';

comment on column public.review_decisions.appeal_of_id is
  'The decision this row appeals, on the tenant key, so never another merchant and never itself.';

comment on column public.review_decisions.appeal_state is
  'none, open, upheld or overturned, the state of the appeal that names this decision.';

comment on column public.review_decisions.created_at is
  'When the row was written.';

comment on column public.review_decisions.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.review_decisions.deleted_at is
  'Soft delete marker, frozen by the guard because a decision is never withdrawn.';

comment on column public.review_decisions.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- The decision history of one merchant, newest first.
create index review_decisions_history_idx
  on public.review_decisions (company_id, decided_at desc)
  where deleted_at is null;

-- The decisions about one subject, newest first.
create index review_decisions_subject_idx
  on public.review_decisions (subject_kind, subject_id, decided_at desc)
  where deleted_at is null;

-- One appeal per decision, so two people cannot file two appeals against one decision.
create unique index review_decisions_appeal_key
  on public.review_decisions (appeal_of_id)
  where appeal_of_id is not null and deleted_at is null;

create trigger review_decisions_guard_state
  before update on public.review_decisions
  for each row
  execute function public.review_decisions_guard_state();

create trigger review_decisions_set_row_metadata
  before update on public.review_decisions
  for each row
  execute function public.set_row_metadata();

alter table public.review_decisions enable row level security;

create policy review_decisions_default_deny
  on public.review_decisions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
