-- path: migrations/0102_onboarding_progress.sql
-- STEP 079 - where a merchant is in the onboarding wizard, so the wizard can be left and resumed.
--
-- Section 5 describes one long form a merchant fills once: business information, address and contact
-- details, the merchant category code, the website review, the address documents, and then the
-- submission the compliance desk reads. A merchant does not sit down and finish that in one go - they
-- have to find a utility bill, ask a colleague for the registered address, and come back tomorrow -
-- so the wizard has to remember where they were. This table is that memory.
--
-- ## Why one row per company and not one row per step
--
-- The question the wizard asks first is "where was I", and that is one read of one row. A row per step
-- would turn the first paint into a join of six rows, and the "which step is next" arithmetic would
-- be done by whichever reader was written last. One row carries the position, and the five steps a
-- merchant has finished are named inside it.
--
-- ## What the position is, and what it is not
--
-- `current_step` is the step the wizard opens on: the merchant's own draft position, nothing more. It
-- is not an approval, a verification or a claim that the data behind it is complete - the steps that
-- collect data (STEPs 080 onward) are the only writers of `completed_steps`, and the compliance desk
-- is the only reader that decides whether a submission passes. Renaming or reordering the six steps
-- later is a migration, not an edit here: `0102` is committed and stays as written.
--
--   - `business`: business information (name, legal form, registration number, what the business does);
--   - `address`: the registered address and the contact details of the person who owns the account;
--   - `category`: the merchant category code and the risk tier it implies;
--   - `website`: the website or store link the business actually sells through;
--   - `documents`: the address proof and source of funds documents;
--   - `review`: the summary a merchant checks before it goes to the compliance desk.
--
-- ## What the constraints keep honest
--
--   - one live row per company, enforced by a partial unique index, so a second tab cannot fork the
--     position into two rows that disagree;
--   - `current_step` is one of the six, so a stale form from an older build cannot store a step this
--     build cannot render;
--   - `completed_steps` is an array of distinct step names and never a name outside the six -
--     enforced by `onboarding_completed_steps_valid`, because a check constraint cannot run a set
--     returning query but a function can;
--   - a row is never started before it was created, and its version only moves forward, which is the
--     same pair every table in this repository carries.
--
-- ## Why the table is default-deny
--
-- The data behind the steps is a merchant's business, and this row says how far along it is. No
-- browser role reads `public` rows here: `services/kyc/onboarding-progress.ts` reads and writes with
-- the service role key after asking the actor's own role and taking the company from the actor's
-- session rather than from the request, so the tenant filter is never the caller's to choose.

begin;

create function public.onboarding_completed_steps_valid(steps jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  total integer;
  distinct_total integer;
  unknown_total integer;
begin
  if steps is null or jsonb_typeof(steps) <> 'array' then
    return false;
  end if;

  total := jsonb_array_length(steps);

  select count(distinct value) into distinct_total
    from jsonb_array_elements_text(steps);

  select count(*) into unknown_total
    from jsonb_array_elements_text(steps)
    where value not in ('business', 'address', 'category', 'website', 'documents', 'review');

  return distinct_total = total and unknown_total = 0;
end;
$$;

comment on function public.onboarding_completed_steps_valid(jsonb) is
  'True when a completed-step list is an array of distinct onboarding step names and nothing else.';

create table public.onboarding_progress (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  updated_by uuid not null,
  current_step text not null default 'business',
  completed_steps jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint onboarding_progress_pkey primary key (id),
  constraint onboarding_progress_tenant_key unique (id, company_id),
  constraint onboarding_progress_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint onboarding_progress_updated_by_fkey foreign key (updated_by)
    references public.users (id),
  constraint onboarding_progress_step_check check (
    current_step in ('business', 'address', 'category', 'website', 'documents', 'review')
  ),
  constraint onboarding_progress_completed_check check (
    public.onboarding_completed_steps_valid(completed_steps)
  ),
  constraint onboarding_progress_started_check check (started_at >= created_at),
  constraint onboarding_progress_row_version_check check (version > 0),
  constraint onboarding_progress_updated_check check (updated_at >= created_at),
  constraint onboarding_progress_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.onboarding_progress is
  'Where one merchant company is in the section 5 onboarding wizard: the step it opens on and the steps it has finished.';

comment on column public.onboarding_progress.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.onboarding_progress.company_id is
  'The merchant company whose progress this is. One live row per company.';

comment on column public.onboarding_progress.updated_by is
  'The account that last saved the position, so a shared merchant login leaves a name behind.';

comment on column public.onboarding_progress.current_step is
  'business, address, category, website, documents or review: the step the wizard opens on.';

comment on column public.onboarding_progress.completed_steps is
  'The steps already finished, as an array of distinct step names from the same six the position uses.';

comment on column public.onboarding_progress.started_at is
  'When the wizard was first saved. A row with no save does not exist, so this is always the first save.';

comment on column public.onboarding_progress.version is
  'Optimistic locking counter. Incremented by the onboarding_progress_set_row_metadata trigger.';

comment on column public.onboarding_progress.deleted_at is
  'Soft delete marker. A progress row is a merchant record, so it is never physically removed here.';

-- One live row per company: a second tab updates the position, it never forks it.
create unique index onboarding_progress_company_key
  on public.onboarding_progress (company_id)
  where deleted_at is null;

create trigger onboarding_progress_set_row_metadata
  before update on public.onboarding_progress
  for each row
  execute function public.set_row_metadata();

alter table public.onboarding_progress enable row level security;

create policy onboarding_progress_default_deny
  on public.onboarding_progress
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
