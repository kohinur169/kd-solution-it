-- path: migrations/0096_office_permission_revoked_by.sql
-- STEP 071 - who withdrew a delegated permission, and when it lapses next.
--
-- `0005_office_permissions.sql` records a grant, the account that made it and the instant a temporary
-- one ends. It records nothing about the other end of the row's life: a grant withdrawn by hand keeps
-- its `revoked_at` and loses the answer to "who ended this, and why should I trust that". Section 2
-- says every permission grant, change and use is audit logged, and the audit chain holds the actor -
-- but a screen that lists what was withdrawn cannot read the chain for each row, and a row that cannot
-- name its end is a row a person has to trust rather than check.
--
-- So this file adds the one column the delegation screen of STEP 071 needs, and the index that screen
-- reads when it asks what lapses next:
--
--   - `revoked_by` names the account that ended the grant early;
--   - `office_permissions_expiry_idx` is the partial index over `expires_at` for grants that are still
--     live, which is the only shape the "ending within seven days" read has.
--
-- ## Why the check is one directional
--
-- Every new withdrawal writes both columns, but rows that were already revoked when this file runs have
-- a `revoked_at` and no account to name - the platform did not record one then. A check that demanded
-- both would refuse this migration on a database with history, so the check says what is true instead:
-- an account may only be named when the grant is revoked, and a revoked grant may predate the record.
--
-- The rollback drops the index and the column, and with them the ability to name a withdrawal. It keeps
-- every grant, every `revoked_at` and the audit chain, so no authority changes when it runs.

begin;

alter table public.office_permissions
  add column revoked_by uuid;

alter table public.office_permissions
  add constraint office_permissions_revoked_by_fkey foreign key (revoked_by)
    references public.users (id);

alter table public.office_permissions
  add constraint office_permissions_revoked_by_check check (
    revoked_by is null or revoked_at is not null
  );

comment on column public.office_permissions.revoked_by is
  'The account that withdrew the grant early, or null for a grant still live or one revoked before STEP 071.';

-- "What lapses next": live grants, soonest end first. `nulls last` is not needed because a partial
-- index over a non-null column is all this read has - a grant without an end is not a grant this
-- platform makes any more, and an old one is sorted out by the code that reads it.
create index office_permissions_expiry_idx
  on public.office_permissions (expires_at)
  where revoked_at is null and deleted_at is null and expires_at is not null;

commit;
