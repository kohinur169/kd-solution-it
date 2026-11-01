-- path: migrations/0072_actor_roles.sql
-- STEP 035 - who is asking, in the vocabulary of FEATURE_LIST section 2.
--
-- `0069` answered "which person" and "which company". The office tables of this STEP need a
-- third answer: which of the seven roles the person holds. The vocabulary is closed by
-- `role_assignments_role_check` ('super_admin', 'ceo', 'compliance_kyc', 'finance_ops',
-- 'support', 'blogger', 'owner'), and `role_assignments_owner_scope_check` requires a
-- `company_id` for `owner` and forbids one for the other six, so the office is platform-wide and
-- the merchant is company-wide by construction rather than by convention.
--
-- A role is read from the table, never from a claim. A JWT can name the person, and `0069`
-- resolves that person to a row in `public.users`; the roles are then the live assignments of
-- that row. Live means three conditions the helper states and the existing partial index
-- `role_assignments` on `(user_id, role) where revoked_at is null and deleted_at is null`
-- already serves: not revoked, not soft deleted, and granted no later than now. A future
-- assignment therefore is no role yet, and a revoked one is no role again.
--
-- The person must also be `active` and undeleted, which is the same gate `0069` applies before
-- it answers a company: a suspended person holds no role even while the assignment row exists.
--
-- Both functions are `security definer` over the assignment table for the reason `0069` gives:
-- `role_assignments` is deny-only until `0073` grants it, and a policy on that table that asks
-- "is this person an office role" would ask itself the question from inside its own predicate.
-- Reading one column of one table keyed by a user id keeps the elevation as small as it can be,
-- and `search_path = ''` keeps it pinned.
--
-- `current_actor_roles()` returns an array so a caller can show a person's roles; the policies
-- read `current_actor_has_role(text)`, which is the same array membership as a boolean and is
-- what lets a policy say `public.current_actor_has_role('finance_ops')` in one line.

begin;

create function public.current_actor_roles()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct r.role order by r.role), '{}'::text[])
    from public.role_assignments r
    join public.users u on u.id = r.user_id
   where r.user_id = public.current_actor_id()
     and r.revoked_at is null
     and r.deleted_at is null
     and r.granted_at <= now()
     and u.status = 'active'
     and u.deleted_at is null;
$$;

comment on function public.current_actor_roles() is
  'The live roles of the person asking, read as the owner so a role policy cannot recurse.';

create function public.current_actor_has_role(role_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(role_name = any (public.current_actor_roles()), false);
$$;

comment on function public.current_actor_has_role(text) is
  'True when the person asking holds that role now; false for a revoked, future or unknown one.';

commit;
