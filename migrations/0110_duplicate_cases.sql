-- path: migrations/0110_duplicate_cases.sql
-- STEP 098 - the duplicate identity case: section 4's "One Person, One Account".
--
-- FEATURE_LIST section 4: "Duplicate checks run at signup, at KYC submission and before sub-merchant
-- creation. Signals: email, phone, identity document number hash, tax id, bank account fingerprint,
-- legal name with date of birth. A match blocks the new account and sends the case to compliance_kyc
-- review."
--
-- This file stores the CASE a match opens, not the check itself - the check is the service's, run at
-- the three stages named above. One row per matched signal of one applicant at one stage:
--
--   1. `stage` is the closed vocabulary signup / kyc_submission / provisioning, and `signal` one of
--      the six section 4 names, so the office queue can be read per stage and per signal without
--      parsing anything. `matched_company_id` and `matched_user_id` name the existing account the
--      signal belongs to; at the signup stage there is no applicant company yet, so the case is
--      filed under the matched tenant.
--   2. The case is `open` when compliance_kyc has not looked at it, then `resolved` with the reviewer,
--      the instant and a trimmed resolution. The checks make the pairing honest and the guard locks
--      a resolved row: a case is history, and the guard refuses every delete and soft delete.
--   3. One open case per (company, stage, signal): the partial unique index makes a repeated check at
--      the same stage converge on the first row instead of piling up cases. The open index is the
--      compliance queue, oldest first; the company index is the applicant's own history.
--   4. RLS is default-deny; the app reads and writes through the PostgREST service role key.

begin;

create function public.duplicate_cases_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a duplicate case is history, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a duplicate case is never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.stage is distinct from old.stage
       or new.signal is distinct from old.signal
       or new.matched_company_id is distinct from old.matched_company_id
       or new.matched_user_id is distinct from old.matched_user_id then
      raise exception 'a duplicate case keeps its tenant, stage, signal and match'
        using errcode = 'check_violation';
    end if;

    if old.status in ('resolved')
       and (to_jsonb(new) - 'updated_at' - 'version')
           is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
      raise exception 'a resolved duplicate case is history'
        using errcode = 'check_violation';
    end if;

    if old.status = 'open' and new.status not in ('open', 'resolved') then
      raise exception 'a duplicate case moves from open to resolved only'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.duplicate_cases_guard_state() is
  'Freezes the match of a duplicate case, walks open to resolved, locks the end state and refuses removal.';

create table public.duplicate_cases (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  stage text not null,
  signal text not null,
  matched_company_id uuid,
  matched_user_id uuid,
  status text not null default 'open',
  reviewed_by uuid,
  reviewed_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint duplicate_cases_pkey primary key (id),
  constraint duplicate_cases_company_fkey foreign key (company_id) references public.companies (id),
  constraint duplicate_cases_matched_company_fkey foreign key (matched_company_id) references public.companies (id),
  constraint duplicate_cases_matched_user_fkey foreign key (matched_user_id) references public.users (id),
  constraint duplicate_cases_reviewed_by_fkey foreign key (reviewed_by) references public.users (id),
  constraint duplicate_cases_stage_check check (stage in ('signup', 'kyc_submission', 'provisioning')),
  constraint duplicate_cases_signal_check check (
    signal in ('email', 'phone', 'identity_document_hash', 'tax_id', 'bank_account_fingerprint', 'legal_name_with_dob')
  ),
  constraint duplicate_cases_status_check check (status in ('open', 'resolved')),
  constraint duplicate_cases_open_check check (
    (status = 'open') = (reviewed_by is null and reviewed_at is null and resolution is null)
  ),
  constraint duplicate_cases_resolved_check check (
    (status = 'resolved') = (reviewed_by is not null and reviewed_at is not null and resolution is not null)
  ),
  constraint duplicate_cases_resolution_check check (
    resolution is null or (char_length(resolution) between 1 and 280 and resolution = btrim(resolution))
  ),
  constraint duplicate_cases_match_check check (
    matched_user_id is null or matched_company_id is not null
  ),
  constraint duplicate_cases_order_check check (reviewed_at is null or reviewed_at >= created_at),
  constraint duplicate_cases_row_version_check check (version > 0),
  constraint duplicate_cases_updated_check check (updated_at >= created_at),
  constraint duplicate_cases_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.duplicate_cases is
  'One matched identity signal of one applicant at one stage, waiting for compliance_kyc review.';

comment on column public.duplicate_cases.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.duplicate_cases.company_id is
  'The tenant the case is filed under: the applicant''s company, or the matched tenant at the signup stage. Frozen.';

comment on column public.duplicate_cases.stage is
  'signup, kyc_submission or provisioning - where the check ran. Frozen.';

comment on column public.duplicate_cases.signal is
  'The matched signal: email, phone, identity_document_hash, tax_id, bank_account_fingerprint or legal_name_with_dob. Frozen.';

comment on column public.duplicate_cases.matched_company_id is
  'The existing company the signal belongs to, when the match is a company. Frozen.';

comment on column public.duplicate_cases.matched_user_id is
  'The existing account the signal belongs to, when the match is a person. Frozen.';

comment on column public.duplicate_cases.status is
  'open while compliance_kyc has not reviewed it, then resolved. The resolved state locks the row.';

comment on column public.duplicate_cases.reviewed_by is
  'The compliance reviewer, required exactly when the status is resolved.';

comment on column public.duplicate_cases.reviewed_at is
  'When the review happened, required exactly when the status is resolved.';

comment on column public.duplicate_cases.resolution is
  'The reviewer''s note, at most 280 characters and trimmed, required exactly when the status is resolved.';

comment on column public.duplicate_cases.created_at is
  'When the match was recorded.';

comment on column public.duplicate_cases.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.duplicate_cases.deleted_at is
  'Never set: the guard refuses the soft delete.';

comment on column public.duplicate_cases.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One open case per tenant, stage and signal: a repeated check at the same stage converges.
create unique index duplicate_cases_open_unique
  on public.duplicate_cases (company_id, stage, signal)
  where status = 'open' and deleted_at is null;

-- The compliance queue: every open case, oldest first.
create index duplicate_cases_open_idx
  on public.duplicate_cases (created_at desc)
  where status = 'open' and deleted_at is null;

-- One tenant's own case history, newest first.
create index duplicate_cases_company_idx
  on public.duplicate_cases (company_id, created_at desc)
  where deleted_at is null;

create trigger duplicate_cases_guard_state
  before insert or update or delete on public.duplicate_cases
  for each row
  execute function public.duplicate_cases_guard_state();

create trigger duplicate_cases_set_row_metadata
  before update on public.duplicate_cases
  for each row
  execute function public.set_row_metadata();

alter table public.duplicate_cases enable row level security;

create policy duplicate_cases_default_deny
  on public.duplicate_cases
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
