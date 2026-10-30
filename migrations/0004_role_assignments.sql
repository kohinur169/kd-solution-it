-- path: migrations/0004_role_assignments.sql
-- STEP 013 - who holds which role, and since when.
--
-- A role is not a column on `users`. Section 2 requires that every permission grant, change and
-- use is audit logged, and a grant that overwrites a previous value records nothing. This table
-- therefore keeps one row per grant, with who granted it, when, and when it was revoked; the live
-- rows are the current answer, the revoked rows are the history.
--
-- The vocabulary is the seven roles of FEATURE_LIST.md section 2. `client` is not here: a client
-- is a tokenized link with no login, so it never holds a role. `finance_ops` is present even
-- though REVISED_FEATURE_LIST_V2 omits it, because FEATURE_LIST.md wins and the conflict is
-- recorded in the STEP 013 handoff.
--
-- One rule is expressible as a constraint and is therefore a constraint: an owner assignment
-- always names the company it owns, and a platform office role never does. The rest - a platform
-- user must not own a company, a user must hold at least one role - needs a wider view than one
-- row, and belongs to the STEP that assigns roles.

begin;

create table public.role_assignments (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  role text not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint role_assignments_pkey primary key (id),
  constraint role_assignments_company_fkey foreign key (company_id) references public.companies (id),
  constraint role_assignments_user_fkey foreign key (user_id) references public.users (id),
  constraint role_assignments_granted_by_fkey foreign key (granted_by) references public.users (id),
  constraint role_assignments_role_check check (
    role in (
      'super_admin',
      'ceo',
      'compliance_kyc',
      'finance_ops',
      'support',
      'blogger',
      'owner'
    )
  ),
  constraint role_assignments_owner_scope_check check (
    (role = 'owner') = (company_id is not null)
  ),
  constraint role_assignments_revoked_after_grant_check check (
    revoked_at is null or revoked_at >= granted_at
  ),
  constraint role_assignments_granted_after_creation_check check (granted_at >= created_at),
  constraint role_assignments_version_positive_check check (version > 0),
  constraint role_assignments_updated_after_creation_check check (updated_at >= created_at),
  constraint role_assignments_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.role_assignments is
  'One grant of one role to one user. Live rows are current access; revoked rows are the history.';

comment on column public.role_assignments.company_id is
  'The company an owner role is scoped to, or null for a platform office role.';

comment on column public.role_assignments.user_id is
  'The account that holds the role.';

comment on column public.role_assignments.role is
  'One of the seven roles in FEATURE_LIST.md section 2. A client never holds a role.';

comment on column public.role_assignments.granted_by is
  'The account that made the grant, or null for the bootstrap grant of STEP 036.';

comment on column public.role_assignments.revoked_at is
  'When the grant stopped being live. A revoked row is kept as history and can be re-granted.';

-- One live grant per user and role; a revoked grant does not block a later one.
create unique index role_assignments_live_key
  on public.role_assignments (user_id, role)
  where revoked_at is null and deleted_at is null;

-- "Who is the owner of this company" and "which office staff hold this role".
create index role_assignments_company_role_idx
  on public.role_assignments (company_id, role)
  where revoked_at is null and deleted_at is null;

create trigger role_assignments_set_row_metadata
  before update on public.role_assignments
  for each row
  execute function public.set_row_metadata();

alter table public.role_assignments enable row level security;

create policy role_assignments_default_deny
  on public.role_assignments
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
