-- path: migrations/0048_kyc_submissions.sql
-- STEP 028 - the KYC submission of section 5.
--
-- A submission is a cycle, not a column on the merchant. A merchant submits the documents of section 5,
-- a reviewer opens it, and it ends `approved` or `rejected`; a merchant that has to try again starts a
-- new row and the old row stays as history, which is what an audit reads. One open submission per
-- merchant is the partial unique index, so two reviewers cannot work two versions of the same file.
--
-- Section 5 runs manual KYC while none of Jumio, Didit or Sumsub is connected and switches to the
-- connected one when it exists, so `verification_method` records which ran. A provider method carries
-- the provider's reference; the manual one carries none. An automatic check that came back incomplete
-- moves to manual review without telling the merchant which method ran, so the merchant only ever reads
-- `status`.
--
-- Four-eye review is a shape here rather than a habit of the screen. When `four_eye_required` is set -
-- large or high-risk merchants - an approved or rejected submission must name a second reviewer, and
-- `kyc_submissions_two_people_check` refuses the same person twice. A rejection carries its reason
-- because the merchant reads it.
--
-- `kyc_submissions_guard_state` freezes the merchant and the person who submitted, and it locks an
-- approved or rejected row, so a decision once written is not rewritten.

begin;

create function public.kyc_submissions_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.submitted_at is distinct from old.submitted_at
     or new.submitted_by is distinct from old.submitted_by then
    raise exception 'a KYC submission keeps its merchant and who submitted it'
      using errcode = 'check_violation';
  end if;

  if old.status in ('approved', 'rejected')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a decided KYC submission is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.kyc_submissions_guard_state() is
  'Freezes the merchant and the submitter of a submission and locks a decided one.';

create table public.kyc_submissions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  verification_method text not null default 'manual',
  status text not null default 'draft',
  submitted_at timestamptz,
  submitted_by uuid,
  first_reviewer_id uuid,
  second_reviewer_id uuid,
  reviewed_at timestamptz,
  decided_at timestamptz,
  decision_reason text,
  provider_reference text,
  high_risk boolean not null default false,
  four_eye_required boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint kyc_submissions_pkey primary key (id),
  constraint kyc_submissions_tenant_key unique (id, company_id),
  constraint kyc_submissions_company_fkey foreign key (company_id) references public.companies (id),
  constraint kyc_submissions_submitted_by_fkey foreign key (submitted_by) references public.users (id),
  constraint kyc_submissions_first_reviewer_fkey foreign key (first_reviewer_id)
    references public.users (id),
  constraint kyc_submissions_second_reviewer_fkey foreign key (second_reviewer_id)
    references public.users (id),
  constraint kyc_submissions_method_check check (
    verification_method in ('manual', 'jumio', 'didit', 'sumsub')
  ),
  constraint kyc_submissions_status_check check (
    status in ('draft', 'submitted', 'in_review', 'approved', 'rejected')
  ),
  constraint kyc_submissions_submitted_check check (
    (status <> 'draft') = (submitted_at is not null)
    and (status <> 'draft') = (submitted_by is not null)
  ),
  constraint kyc_submissions_reviewer_check check (
    (status in ('in_review', 'approved', 'rejected')) = (first_reviewer_id is not null)
  ),
  constraint kyc_submissions_second_reviewer_check check (
    (four_eye_required and status in ('approved', 'rejected')) = (second_reviewer_id is not null)
  ),
  constraint kyc_submissions_two_people_check check (
    second_reviewer_id is null or second_reviewer_id <> first_reviewer_id
  ),
  constraint kyc_submissions_reviewed_instant_check check (
    (status in ('approved', 'rejected')) = (reviewed_at is not null)
  ),
  constraint kyc_submissions_decided_instant_check check (
    (status in ('approved', 'rejected')) = (decided_at is not null)
  ),
  constraint kyc_submissions_reason_check check (
    (status <> 'rejected' or decision_reason is not null)
    and (
      decision_reason is null
      or (
        char_length(decision_reason) between 1 and 280
        and decision_reason = btrim(decision_reason)
      )
    )
  ),
  constraint kyc_submissions_provider_check check (
    (verification_method <> 'manual') = (provider_reference is not null)
    and (
      provider_reference is null
      or (
        char_length(provider_reference) between 1 and 160
        and provider_reference = btrim(provider_reference)
      )
    )
  ),
  constraint kyc_submissions_instant_order_check check (
    (submitted_at is null or submitted_at >= created_at)
    and (reviewed_at is null or (submitted_at is not null and reviewed_at >= submitted_at))
    and (decided_at is null or (submitted_at is not null and decided_at >= submitted_at))
  ),
  constraint kyc_submissions_expiry_check check (
    expires_at is null or (submitted_at is not null and expires_at > submitted_at)
  ),
  constraint kyc_submissions_row_version_check check (version > 0),
  constraint kyc_submissions_updated_check check (updated_at >= created_at),
  constraint kyc_submissions_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.kyc_submissions is
  'One KYC cycle of one merchant, with its method, its reviewers and its decision.';

comment on column public.kyc_submissions.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.kyc_submissions.company_id is
  'The merchant under review. Frozen after the row is written.';

comment on column public.kyc_submissions.verification_method is
  'manual, jumio, didit or sumsub, which of the methods of section 5 ran.';

comment on column public.kyc_submissions.status is
  'draft, submitted, in_review, approved or rejected. The last two lock the row.';

comment on column public.kyc_submissions.submitted_at is
  'When the merchant submitted. Null while the row is a draft.';

comment on column public.kyc_submissions.submitted_by is
  'The person who submitted, required with the instant.';

comment on column public.kyc_submissions.first_reviewer_id is
  'The reviewer who opened the submission.';

comment on column public.kyc_submissions.second_reviewer_id is
  'The second reviewer of a four-eye decision, never the same person as the first.';

comment on column public.kyc_submissions.reviewed_at is
  'Set exactly when the submission was decided.';

comment on column public.kyc_submissions.decided_at is
  'Set exactly when the decision was recorded.';

comment on column public.kyc_submissions.decision_reason is
  'Why the submission was rejected, at most 280 characters and trimmed.';

comment on column public.kyc_submissions.provider_reference is
  'The identifier the KYC provider returned, present exactly on a provider method.';

comment on column public.kyc_submissions.high_risk is
  'The compliance team marked the merchant high risk.';

comment on column public.kyc_submissions.four_eye_required is
  'Large or high-risk merchants need two reviewers, per section 5.';

comment on column public.kyc_submissions.expires_at is
  'When the submitted evidence stops being valid, when the team sets it.';

comment on column public.kyc_submissions.created_at is
  'When the row was written.';

comment on column public.kyc_submissions.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.kyc_submissions.deleted_at is
  'Soft delete marker, refused once the submission is decided.';

comment on column public.kyc_submissions.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One open submission per merchant, so two reviewers cannot work two files at once.
create unique index kyc_submissions_open_key
  on public.kyc_submissions (company_id)
  where status in ('draft', 'submitted', 'in_review') and deleted_at is null;

-- The review queue of section 5, oldest submission first.
create index kyc_submissions_queue_idx
  on public.kyc_submissions (company_id, submitted_at)
  where status in ('submitted', 'in_review') and deleted_at is null;

-- The decision history of one merchant, newest first.
create index kyc_submissions_decided_idx
  on public.kyc_submissions (company_id, decided_at desc)
  where status in ('approved', 'rejected') and deleted_at is null;

create trigger kyc_submissions_guard_state
  before update on public.kyc_submissions
  for each row
  execute function public.kyc_submissions_guard_state();

create trigger kyc_submissions_set_row_metadata
  before update on public.kyc_submissions
  for each row
  execute function public.set_row_metadata();

alter table public.kyc_submissions enable row level security;

create policy kyc_submissions_default_deny
  on public.kyc_submissions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
