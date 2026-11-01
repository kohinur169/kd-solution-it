-- path: migrations/0069_actor_session.sql
-- STEP 033 - who is asking: the three functions every tenant policy of section 2 reads.
--
-- STEP 012 to STEP 032 enabled row level security and denied every row, table by table, and left
-- the question of a caller unanswered. This file answers it once, so the 22 policies of `0070`
-- can be one line each instead of a predicate written 22 times.
--
-- The platform reaches the database two ways. A server connection from `DATABASE_URL` runs
-- migrations and background jobs and can set a session setting inside its transaction; a browser
-- arrives through Supabase with a signed JWT and no ability to write one. `current_actor_id()`
-- reads the setting first and the `sub` claim of the JWT second, so the same policy serves the
-- web request, the worker and the proof, and no `auth` schema, extension or role is needed, which
-- is the rule this folder has followed since `0001`.
--
-- The company is then read from `public.users`, not from a claim. A caller who can set the
-- session setting can name a person; they cannot name a company, because the company is a column
-- of that person's row. A suspended or deleted person resolves to no company and therefore to no
-- rows, which is what section 2 asks of a suspended account.
--
-- `current_actor_company_id()` is `security definer`, the pattern `audit_logs_guard_chain` already
-- uses: it reads `users` as the table owner, so the `users` tenant policy of `0070` cannot ask
-- itself the same question from inside its own predicate and recurse. It reads one column of one
-- row keyed by the primary key, so the elevation is as small as it can be.
--
-- `uuid_or_null()` is the guard that keeps a malformed request from becoming an error: a claim
-- that is not a uuid, a setting that is empty and a claims value that is not a JSON object all
-- come back null, and a policy that compares against null matches nothing.

begin;

create function public.uuid_or_null(value text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
           when value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then value::uuid
         end;
$$;

comment on function public.uuid_or_null(text) is
  'Returns the uuid a text spells, or null when it does not spell one. It never raises.';

create function public.current_actor_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(
    public.uuid_or_null(pg_catalog.current_setting('app.user_id', true)),
    public.uuid_or_null(
      case
        when pg_catalog.current_setting('request.jwt.claims', true) ~ '^\{'
          then pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
      end
    )
  );
$$;

comment on function public.current_actor_id() is
  'The person asking: the app.user_id setting, or the sub claim of a Supabase JWT. Null otherwise.';

create function public.current_actor_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.company_id
    from public.users u
   where u.id = public.current_actor_id()
     and u.status = 'active'
     and u.deleted_at is null;
$$;

comment on function public.current_actor_company_id() is
  'The company of the person asking, read as the owner so the users policy cannot recurse.';

commit;
