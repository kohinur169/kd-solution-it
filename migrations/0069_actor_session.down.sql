-- path: migrations/0069_actor_session.down.sql
-- STEP 033 - the rollback of the three actor functions. It runs after the rollback of `0070`,
-- because a policy that reads a function cannot outlive it.

begin;

drop function if exists public.current_actor_company_id();

drop function if exists public.current_actor_id();

drop function if exists public.uuid_or_null(text);

commit;
