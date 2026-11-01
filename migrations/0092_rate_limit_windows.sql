-- path: migrations/0092_rate_limit_windows.sql
-- STEP 055 - the per address counter behind IP based rate limiting.
--
-- Section 22 line 242 requires IP based rate limiting on the authentication endpoints, and line 238
-- requires that "failed attempt counters and lock state are stored in the database and survive
-- server restarts". A counter in process memory would satisfy neither: it resets on deploy, it is
-- per instance, and the attack this exists for is the one that spreads requests over both.
--
-- ## One row per address and scope
--
-- `0011_login_attempts` records what happened on one attempt, and its comment notes that the IP
-- limit could be a query over it. That is true for the two endpoints that write an attempt and false
-- for the other twelve, and a count over an append only table cannot be incremented atomically. This
-- table is the counter itself: one row per (scope, address), and the whole decision moves it with a
-- single statement.
--
-- `window_started_at` is the start of the fixed window the row is counting. When the window lapses the
-- same statement rewrites the row to `hits = 1` and a new start, so a window costs no rows and there
-- is nothing per request to retire. Growth is one row per address that has ever called a limited
-- endpoint, which is the same order as `login_attempts` and is retired by the retention job of
-- section 27 like every other table in that group.
--
-- ## The address is not stored
--
-- `key_hash` is the SHA-256 of the canonical address in lower case hex, which is the shape
-- `login_attempts.email_hash` already uses and for the same reason: the counter needs equality and
-- nothing else, and a table of addresses is a table of people. The address itself still reaches the
-- audit entry and the log, where an operator needs it to act.
--
-- `scope` is the endpoint's own name from `lib/auth/rate-limit.ts` (`signin`, `session_rotate`, ...),
-- so one address has one window per endpoint and a limit on one endpoint never spends another's.
--
-- ## Why the increment is a function
--
-- The decision is "read the counter, decide, write it back", and doing that from the service would
-- lose increments under exactly the burst the limit exists for: two requests would read nine hits and
-- both write ten. `consume_rate_limit` performs it as one `insert ... on conflict ... do update ...
-- where hits < limit`, so the row lock Postgres takes on the conflicting row is the serialisation
-- point, and the answer is the state after this attempt.
--
-- `refused_at` is written once per window, by the refusal path. It is what lets the service audit an
-- attack once instead of once per request, and it is cleared when the window rolls over.
--
-- ## What this file deliberately does not do
--
-- It does not delete old rows: a migration is not allowed to remove rows, and retention is the
-- section 27 cleanup job's business, like `login_attempts`. It does not store the address, the user,
-- the company or the outcome: this is a counter, and the record of an attempt is `0011`'s.

begin;

create table public.rate_limit_windows (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  window_seconds integer not null,
  hits integer not null default 0,
  refused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint rate_limit_windows_pkey primary key (id),
  constraint rate_limit_windows_company_fkey foreign key (company_id) references public.companies (id),
  constraint rate_limit_windows_scope_key_unique unique (scope, key_hash),
  constraint rate_limit_windows_scope_check check (scope ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint rate_limit_windows_key_hash_check check (key_hash ~ '^[a-f0-9]{64}$'),
  constraint rate_limit_windows_window_seconds_check check (window_seconds between 1 and 86400),
  constraint rate_limit_windows_hits_check check (hits >= 0),
  constraint rate_limit_windows_refusal_inside_window_check check (
    refused_at is null or refused_at >= window_started_at
  ),
  constraint rate_limit_windows_version_positive_check check (version > 0),
  constraint rate_limit_windows_updated_after_creation_check check (updated_at >= created_at),
  constraint rate_limit_windows_deleted_after_creation_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.rate_limit_windows is
  'One counter per (scope, address hash) for section 22 IP rate limiting. Moved by public.consume_rate_limit, never by the service.';

comment on column public.rate_limit_windows.company_id is
  'Always null today: an address window belongs to the platform, not to a tenant. The column exists because every table in this schema carries it.';

comment on column public.rate_limit_windows.scope is
  'The endpoint the window counts, as named in lib/auth/rate-limit.ts. One window per scope per address.';

comment on column public.rate_limit_windows.key_hash is
  'SHA-256 of the canonical client address, hex. The address itself is never stored.';

comment on column public.rate_limit_windows.window_started_at is
  'Start of the fixed window this row is counting. Rewritten when the window lapses.';

comment on column public.rate_limit_windows.hits is
  'Requests counted in this window, up to the limit. The request that reaches the limit is allowed; the next one is refused.';

comment on column public.rate_limit_windows.refused_at is
  'The instant the first request past the limit was refused in this window, so the audit entry is written once.';

-- Retention: the section 27 cleanup job reads rows that have not moved in a while.
create index rate_limit_windows_updated_idx
  on public.rate_limit_windows (updated_at)
  where deleted_at is null;

create trigger rate_limit_windows_set_row_metadata
  before update on public.rate_limit_windows
  for each row
  execute function public.set_row_metadata();

alter table public.rate_limit_windows enable row level security;

create policy rate_limit_windows_default_deny
  on public.rate_limit_windows
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- One attempt against one window, decided and written in one statement.
--
-- The answer is the state after this attempt:
--
--   allowed             - true when this request may proceed;
--   remaining           - how many more requests fit in the window;
--   retry_after_seconds - for a refusal, the seconds until the window rolls over;
--   first_refusal       - true when this refusal is the first of the window, which is when the
--                         service writes the audit entry.
--
-- A lapsed window is not an error: the conflicting row is rewritten to `hits = 1` and the instant it
-- started. `hits` is never decremented and never rewritten past the limit, so the ceiling is exact.
--
-- The function runs with the caller's rights (`search_path` is empty and every object is schema
-- qualified), which is the same convention as the audit chain functions of `0075`: the service key
-- that calls it is the role the platform writes with, and no second, broader identity is introduced.
create function public.consume_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer,
  first_refusal boolean
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  window_start timestamptz;
  counted_hits integer;
  retry_after integer;
  refusals integer;
begin
  if p_limit < 1 then
    raise exception 'a rate limit needs a limit of at least one';
  end if;

  if p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'a rate window must be between one second and one day';
  end if;

  if p_scope !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'a rate limit scope is lower snake case';
  end if;

  if p_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'a rate limit key is the hex sha256 of the address';
  end if;

  window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(
      pg_catalog.date_part('epoch', p_now) / p_window_seconds
    ) * p_window_seconds
  );

  retry_after := greatest(
    1,
    pg_catalog.ceil(
      pg_catalog.date_part(
        'epoch',
        window_start + pg_catalog.make_interval(secs => p_window_seconds) - p_now
      )
    )::integer
  );

  -- One statement: the row lock it takes is what makes two simultaneous attempts serial.
  insert into public.rate_limit_windows as counter_row (
    scope,
    key_hash,
    window_started_at,
    window_seconds,
    hits
  )
  values (
    p_scope,
    p_key_hash,
    window_start,
    p_window_seconds,
    1
  )
  on conflict on constraint rate_limit_windows_scope_key_unique do update
    set
      hits = case
               when counter_row.window_started_at < window_start then 1
               else counter_row.hits + 1
             end,
      window_started_at = case
                            when counter_row.window_started_at < window_start then window_start
                            else counter_row.window_started_at
                          end,
      window_seconds = p_window_seconds,
      refused_at = case
                     when counter_row.window_started_at < window_start then null
                     else counter_row.refused_at
                   end
    where counter_row.window_started_at < window_start
       or counter_row.hits < p_limit
  returning hits into counted_hits;

  if counted_hits is null then
    -- The window is full: `hits` is at the limit and the statement above matched no row.
    update public.rate_limit_windows target_row
       set refused_at = p_now
     where target_row.scope = p_scope
       and target_row.key_hash = p_key_hash
       and target_row.refused_at is null;

    get diagnostics refusals = row_count;

    return query select false, 0, retry_after, refusals > 0;
    return;
  end if;

  return query select true, greatest(0, p_limit - counted_hits), 0, false;
end;
$$;

comment on function public.consume_rate_limit(text, text, integer, integer, timestamptz) is
  'Counts one attempt against one window and answers whether it may proceed. The single writer of public.rate_limit_windows.';

commit;
