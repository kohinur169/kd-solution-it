-- path: migrations/0096_office_permission_revoked_by.down.sql
-- STEP 071 rollback of 0096: forget who withdrew a delegation, keep the withdrawals themselves.
--
-- Running this loses one fact per withdrawn grant - the account that ended it - and nothing else. Each
-- row keeps its `revoked_at`, so no authority returns when the column goes, and the audit chain still
-- holds the actor for every withdrawal made after this STEP. The screen that reads the column is
-- removed in the same commit, so nothing is left asking for a column that is not there.

begin;

drop index if exists public.office_permissions_expiry_idx;

alter table public.office_permissions
  drop constraint if exists office_permissions_revoked_by_check;

alter table public.office_permissions
  drop constraint if exists office_permissions_revoked_by_fkey;

alter table public.office_permissions
  drop column if exists revoked_by;

commit;
