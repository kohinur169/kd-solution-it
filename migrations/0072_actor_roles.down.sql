-- path: migrations/0072_actor_roles.down.sql
-- STEP 035 - the rollback of the two role helpers. It runs after the rollback of `0074` and
-- `0073`, because a policy that reads a function cannot outlive it.

begin;

drop function if exists public.current_actor_has_role(text);

drop function if exists public.current_actor_roles();

commit;
