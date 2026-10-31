-- path: migrations/0051_sanctions_screenings.sql
-- STEP 028 - sanctions and PEP screening, section 3.
--
-- Section 3 screens against four lists - OFAC, the United Nations, the European Union and the
-- United States - and section 3 also says SAR information is visible only to `compliance_kyc` and
-- `super_admin` and never to the merchant. The four lists are four booleans rather than one free
-- text field, so a screening that covered only OFAC says so, and at least one of them must be true.
--
-- A row names its subject: the merchant itself, a beneficial owner or a person, with
-- `subject_kind` and `subject_id`. A company subject must name its own merchant, which one check
-- enforces; the two other kinds are looked up by the service that writes the row, the same way the
-- rest of the schema keeps a polymorphic reference out of a foreign key.
--
-- `result` is the closed vocabulary `clear`, `possible_match` and `confirmed_match`. A confirmed
-- match carries the note of the case, and `sar_case` marks the case file that becomes a suspicious
-- activity report; the flag can be raised later but never lowered, which is what the guard refuses.
-- The permissive read policy that hides these rows from the merchant is STEP 035's job; here the
-- table is default-deny like every other.

begin;

create function public.sanctions_screenings_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.subject_kind is distinct from old.subject_kind
     or new.subject_id is distinct from old.subject_id
     or new.ofac_checked is distinct from old.ofac_checked
     or new.un_checked is distinct from old.un_checked
     or new.eu_checked is distinct from old.eu_checked
     or new.us_checked is distinct from old.us_checked
     or new.result is distinct from old.result
     or new.provider is distinct from old.provider
     or new.screened_at is distinct from old.screened_at then
    raise exception 'a screening keeps its subject, its lists, its result and its instant'
      using errcode = 'check_violation';
  end if;

  if old.sar_case and new.sar_case is distinct from old.sar_case then
    raise exception 'a SAR case file is never closed by clearing the flag'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.sanctions_screenings_guard_state() is
  'Freezes the subject, the lists, the result and the instant of a screening, and keeps a SAR flag.';

create table public.sanctions_screenings (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  subject_kind text not null,
  subject_id uuid not null,
  ofac_checked boolean not null default false,
  un_checked boolean not null default false,
  eu_checked boolean not null default false,
  us_checked boolean not null default false,
  result text not null,
  provider text not null default 'manual',
  screened_at timestamptz not null default now(),
  note text,
  sar_case boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint sanctions_screenings_pkey primary key (id),
  constraint sanctions_screenings_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint sanctions_screenings_subject_key unique (
    company_id, subject_kind, subject_id, ofac_checked, un_checked, eu_checked, us_checked,
    screened_at
  ),
  constraint sanctions_screenings_subject_kind_check check (
    subject_kind in ('company', 'ubo', 'person')
  ),
  constraint sanctions_screenings_subject_company_check check (
    subject_kind <> 'company' or subject_id = company_id
  ),
  constraint sanctions_screenings_result_check check (
    result in ('clear', 'possible_match', 'confirmed_match')
  ),
  constraint sanctions_screenings_provider_check check (
    provider in ('manual', 'jumio', 'didit', 'sumsub')
  ),
  constraint sanctions_screenings_lists_check check (
    ofac_checked or un_checked or eu_checked or us_checked
  ),
  constraint sanctions_screenings_note_check check (
    (result <> 'confirmed_match' or note is not null)
    and (
      note is null
      or (
        char_length(note) between 1 and 500
        and note = btrim(note)
      )
    )
  ),
  constraint sanctions_screenings_sar_check check (
    not sar_case or result = 'confirmed_match'
  ),
  constraint sanctions_screenings_row_version_check check (version > 0),
  constraint sanctions_screenings_updated_check check (updated_at >= created_at),
  constraint sanctions_screenings_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.sanctions_screenings is
  'One sanctions and PEP screening of one subject against one set of lists at one instant.';

comment on column public.sanctions_screenings.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.sanctions_screenings.company_id is
  'The merchant the screening belongs to. Frozen after the row is written.';

comment on column public.sanctions_screenings.subject_kind is
  'company, ubo or person, which of the three subjects of section 3 was screened.';

comment on column public.sanctions_screenings.subject_id is
  'The id of the subject in its own table. A company subject names its own merchant.';

comment on column public.sanctions_screenings.ofac_checked is
  'The OFAC list was part of this screening.';

comment on column public.sanctions_screenings.un_checked is
  'The United Nations list was part of this screening.';

comment on column public.sanctions_screenings.eu_checked is
  'The European Union list was part of this screening.';

comment on column public.sanctions_screenings.us_checked is
  'The United States list was part of this screening.';

comment on column public.sanctions_screenings.result is
  'clear, possible_match or confirmed_match.';

comment on column public.sanctions_screenings.provider is
  'manual, jumio, didit or sumsub, which provider ran the screening.';

comment on column public.sanctions_screenings.screened_at is
  'When the screening ran.';

comment on column public.sanctions_screenings.note is
  'The case note, required on a confirmed match, at most 500 characters and trimmed.';

comment on column public.sanctions_screenings.sar_case is
  'The case file became a SAR. Only compliance_kyc and super_admin may read it, per section 3.';

comment on column public.sanctions_screenings.created_at is
  'When the row was written.';

comment on column public.sanctions_screenings.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.sanctions_screenings.deleted_at is
  'Soft delete marker.';

comment on column public.sanctions_screenings.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- The screening history of one subject, newest first.
create index sanctions_screenings_subject_idx
  on public.sanctions_screenings (subject_kind, subject_id, screened_at desc)
  where deleted_at is null;

-- The screening history of one merchant, newest first.
create index sanctions_screenings_company_idx
  on public.sanctions_screenings (company_id, screened_at desc)
  where deleted_at is null;

-- What needs a person: a possible or a confirmed match.
create index sanctions_screenings_match_idx
  on public.sanctions_screenings (company_id, screened_at)
  where result <> 'clear' and deleted_at is null;

-- The case files that became a SAR.
create index sanctions_screenings_sar_idx
  on public.sanctions_screenings (company_id)
  where sar_case and deleted_at is null;

create trigger sanctions_screenings_guard_state
  before update on public.sanctions_screenings
  for each row
  execute function public.sanctions_screenings_guard_state();

create trigger sanctions_screenings_set_row_metadata
  before update on public.sanctions_screenings
  for each row
  execute function public.set_row_metadata();

alter table public.sanctions_screenings enable row level security;

create policy sanctions_screenings_default_deny
  on public.sanctions_screenings
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
