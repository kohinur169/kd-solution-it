-- path: migrations/0007_announcements.sql
-- STEP 014 - platform announcements.
--
-- Section 24: "super_admin publishes announcements that appear as popups everywhere. A user can
-- dismiss an announcement, and a dismissed announcement does not appear again for that user."
-- This table is the announcement itself; the dismissal is one row per user in 0008, because
-- "everyone dismissed it" and "this person dismissed it" are different facts and only the second
-- one survives a new user.
--
-- An announcement is a draft until `published_at` is set, which is why the column is nullable
-- instead of a status keyword: the publish instant is what a popup query filters on, and a status
-- column would let the two disagree. `expires_at` stops a stale banner without a job, and
-- `level` lets the interface choose an emphasis without parsing prose.
--
-- `audience` is a closed three value vocabulary rather than a role list, because the popup is
-- shown by the shell, not by a permission check: office staff and merchant owners see different
-- sets, and a new role must not silently inherit a banner meant for a merchant.

begin;

create table public.announcements (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  title text not null,
  body text not null,
  level text not null default 'info',
  audience text not null default 'all',
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint announcements_pkey primary key (id),
  constraint announcements_company_fkey foreign key (company_id) references public.companies (id),
  constraint announcements_created_by_fkey foreign key (created_by) references public.users (id),
  constraint announcements_title_check check (
    char_length(title) between 1 and 140 and title = btrim(title)
  ),
  constraint announcements_body_check check (char_length(btrim(body)) between 1 and 5000),
  constraint announcements_level_check check (level in ('info', 'warning', 'critical')),
  constraint announcements_audience_check check (audience in ('all', 'owners', 'office')),
  constraint announcements_expiry_check check (
    expires_at is null or published_at is null or expires_at > published_at
  ),
  constraint announcements_version_positive_check check (version > 0),
  constraint announcements_updated_after_creation_check check (updated_at >= created_at),
  constraint announcements_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.announcements is
  'A platform announcement shown as a popup. Draft until published_at is set.';

comment on column public.announcements.company_id is
  'Company the announcement is for, or null for a platform wide announcement.';

comment on column public.announcements.title is
  'Short headline, trimmed, 1 to 140 characters.';

comment on column public.announcements.body is
  'Message text, at most 5000 characters. Rendered as text, never as raw HTML.';

comment on column public.announcements.level is
  'info, warning or critical. Chooses the emphasis in the interface.';

comment on column public.announcements.audience is
  'all, owners or office. The shell decides who sees the popup.';

comment on column public.announcements.published_at is
  'When the announcement became visible, or null while it is a draft.';

comment on column public.announcements.expires_at is
  'When it stops being shown, even if nobody dismissed it.';

comment on column public.announcements.created_by is
  'The account that wrote it, or null for a seeded announcement.';

-- The popup query: published, not expired, newest first.
create index announcements_published_idx
  on public.announcements (published_at desc)
  where published_at is not null and deleted_at is null;

create trigger announcements_set_row_metadata
  before update on public.announcements
  for each row
  execute function public.set_row_metadata();

alter table public.announcements enable row level security;

create policy announcements_default_deny
  on public.announcements
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
