-- path: migrations/0006_delegations.sql
-- STEP 014 - an office user handing an approval to another office user for a window.
--
-- This is the approval chain of section 2 made durable. A CEO who is away delegates one scope -
-- for example `payout.release` or `kyc.final_approval` - to a named colleague between two
-- instants. The delegation is time boxed because an approval authority that never expires is
-- indistinguishable from a permanent role change, and it is scoped because delegating "everything"
-- is what roles are for.
--
-- The delegator is always an account, never a job: an authority handed out by a background worker
-- cannot be audited to a person. `revoked_at` ends a delegation early, `deleted_at` is a soft
-- close, and `expires_at` does not exist here - `ends_at` is required, so every delegation has a
-- stop.
--
-- Nothing in this table grants a permission by itself; it records that person A said person B may
-- act in a named scope until an instant. The STEP that performs an approval reads the delegation
-- and the permission rows together.

begin;

create table public.delegations (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  delegator_user_id uuid not null,
  delegate_user_id uuid not null,
  scope text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  reason text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint delegations_pkey primary key (id),
  constraint delegations_company_fkey foreign key (company_id) references public.companies (id),
  constraint delegations_delegator_fkey foreign key (delegator_user_id) references public.users (id),
  constraint delegations_delegate_fkey foreign key (delegate_user_id) references public.users (id),
  constraint delegations_distinct_users_check check (delegator_user_id <> delegate_user_id),
  constraint delegations_scope_check check (
    scope ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$' and char_length(scope) <= 64
  ),
  constraint delegations_window_check check (ends_at > starts_at),
  constraint delegations_revoked_check check (revoked_at is null or revoked_at >= starts_at),
  constraint delegations_reason_check check (
    reason is null or char_length(reason) between 1 and 280
  ),
  constraint delegations_version_positive_check check (version > 0),
  constraint delegations_updated_after_creation_check check (updated_at >= created_at),
  constraint delegations_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.delegations is
  'One office user handing one approval scope to another for a bounded window.';

comment on column public.delegations.company_id is
  'Company the delegation applies to, or null when the scope is platform wide.';

comment on column public.delegations.delegator_user_id is
  'The office user who holds the authority and hands it out.';

comment on column public.delegations.delegate_user_id is
  'The office user who may act in the scope while the delegation is live.';

comment on column public.delegations.scope is
  'Dotted approval scope such as payout.release. A delegation is never unbounded.';

comment on column public.delegations.starts_at is
  'First instant the delegate may act. Defaults to now.';

comment on column public.delegations.ends_at is
  'Last instant the delegate may act. Required, so every delegation stops by itself.';

comment on column public.delegations.revoked_at is
  'When the delegator ended the delegation early. A revoked row is kept as history.';

-- One live delegation per pair and scope; an ended one does not block a later one.
create unique index delegations_live_key
  on public.delegations (delegator_user_id, delegate_user_id, scope)
  where revoked_at is null and deleted_at is null;

-- "What may this person approve right now" reads live rows ordered by the end instant.
create index delegations_delegate_idx
  on public.delegations (delegate_user_id, ends_at)
  where revoked_at is null and deleted_at is null;

create trigger delegations_set_row_metadata
  before update on public.delegations
  for each row
  execute function public.set_row_metadata();

alter table public.delegations enable row level security;

create policy delegations_default_deny
  on public.delegations
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
