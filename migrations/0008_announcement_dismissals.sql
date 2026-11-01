-- path: migrations/0008_announcement_dismissals.sql
-- STEP 014 - the record of a person closing an announcement.
--
-- Section 24: "A user can dismiss an announcement, and a dismissed announcement does not appear
-- again for that user." That sentence is a uniqueness rule, so it is a unique index: one row per
-- announcement and user, and a second dismiss is a no-op the database refuses rather than a
-- growing table of duplicates.
--
-- The row is never deleted. A dismissal is a fact about a person, and the audit trail of what a
-- user was shown is part of how the platform explains itself later; `deleted_at` exists because
-- every table carries it, not because a dismissal is expected to be removed.
--
-- `company_id` mirrors the dismissing user's company, or is null for platform staff, so a query
-- for "what has this company dismissed" does not need a join on every page load.

begin;

create table public.announcement_dismissals (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  announcement_id uuid not null,
  user_id uuid not null,
  dismissed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint announcement_dismissals_pkey primary key (id),
  constraint announcement_dismissals_company_fkey
    foreign key (company_id) references public.companies (id),
  constraint announcement_dismissals_announcement_fkey
    foreign key (announcement_id) references public.announcements (id),
  constraint announcement_dismissals_user_fkey foreign key (user_id) references public.users (id),
  constraint announcement_dismissals_time_check check (dismissed_at >= created_at),
  constraint announcement_dismissals_version_positive_check check (version > 0),
  constraint announcement_dismissals_updated_after_creation_check check (updated_at >= created_at),
  constraint announcement_dismissals_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.announcement_dismissals is
  'One row per person per announcement they closed. A dismissal is never repeated or removed.';

comment on column public.announcement_dismissals.company_id is
  'Company of the dismissing user, or null for platform staff.';

comment on column public.announcement_dismissals.announcement_id is
  'The announcement that was closed.';

comment on column public.announcement_dismissals.user_id is
  'The person who closed it. The pair with announcement_id is unique.';

-- A dismissed announcement never appears again for that user, enforced by the database.
create unique index announcement_dismissals_key
  on public.announcement_dismissals (announcement_id, user_id);

-- "Which announcements has this person already closed" for the popup query.
create index announcement_dismissals_user_idx
  on public.announcement_dismissals (user_id, announcement_id);

create trigger announcement_dismissals_set_row_metadata
  before update on public.announcement_dismissals
  for each row
  execute function public.set_row_metadata();

alter table public.announcement_dismissals enable row level security;

create policy announcement_dismissals_default_deny
  on public.announcement_dismissals
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
