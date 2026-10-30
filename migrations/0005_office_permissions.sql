-- path: migrations/0005_office_permissions.sql
-- STEP 014 - delegated office permissions.
--
-- Section 2 says "super_admin ... delegates permissions to office roles", and that "every
-- permission grant, change and use is audit logged". A role (`role_assignments`) answers "what
-- kind of office user is this"; this table answers "which specific action may this person take".
-- The two are separate on purpose: a support agent who is temporarily allowed to release a small
-- payout gets one row here, not a new role and not a change to their role history.
--
-- The permission is a dotted key such as `payout.release` or `kyc.decide`. Like the job names and
-- the role vocabulary, the catalog lives in code and this column stores the string, so a new
-- permission does not need a migration and a typo is refused by the format check.
--
-- A grant is bounded: `expires_at` makes a temporary delegation self clearing, and `revoked_at`
-- ends one early. The live row is the permission; the revoked rows are the audit trail.

begin;

create table public.office_permissions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  permission text not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint office_permissions_pkey primary key (id),
  constraint office_permissions_company_fkey foreign key (company_id) references public.companies (id),
  constraint office_permissions_user_fkey foreign key (user_id) references public.users (id),
  constraint office_permissions_granted_by_fkey foreign key (granted_by) references public.users (id),
  constraint office_permissions_permission_check check (
    permission ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$' and char_length(permission) <= 64
  ),
  constraint office_permissions_expiry_check check (
    expires_at is null or expires_at > granted_at
  ),
  constraint office_permissions_revoked_check check (
    revoked_at is null or revoked_at >= granted_at
  ),
  constraint office_permissions_reason_check check (
    reason is null or char_length(reason) between 1 and 280
  ),
  constraint office_permissions_version_positive_check check (version > 0),
  constraint office_permissions_updated_after_creation_check check (updated_at >= created_at),
  constraint office_permissions_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.office_permissions is
  'One delegated permission for one office user. Live rows grant, revoked rows are the history.';

comment on column public.office_permissions.company_id is
  'Tenant scope when the permission acts on one company, or null for a platform wide staff role.';

comment on column public.office_permissions.user_id is
  'The office user who may perform the action.';

comment on column public.office_permissions.permission is
  'Dotted permission key such as payout.release. The catalog lives in code, the row stores the key.';

comment on column public.office_permissions.granted_by is
  'The account that delegated the permission, or null for a bootstrap grant.';

comment on column public.office_permissions.expires_at is
  'When a temporary delegation ends by itself, or null for a grant that lasts until revoked.';

comment on column public.office_permissions.revoked_at is
  'When the grant was withdrawn. A revoked row is kept as history.';

comment on column public.office_permissions.reason is
  'Why the permission was delegated. Shown in the audit screen; never a secret.';

-- One live grant per user and permission; a revoked grant does not block a later one.
create unique index office_permissions_live_key
  on public.office_permissions (user_id, permission)
  where revoked_at is null and deleted_at is null;

-- "Who may release a payout right now" and "which permissions does this person hold".
create index office_permissions_permission_idx
  on public.office_permissions (permission)
  where revoked_at is null and deleted_at is null;

create index office_permissions_user_idx
  on public.office_permissions (user_id)
  where revoked_at is null and deleted_at is null;

create trigger office_permissions_set_row_metadata
  before update on public.office_permissions
  for each row
  execute function public.set_row_metadata();

alter table public.office_permissions enable row level security;

create policy office_permissions_default_deny
  on public.office_permissions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
