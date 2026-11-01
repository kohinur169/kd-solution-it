-- path: migrations/0011_login_attempts.sql
-- STEP 016 - every authentication attempt, and the counters it produces.
--
-- Section 22 requires that "failed attempt counters and lock state are stored in the database and
-- survive server restarts". The counters are therefore not a number in memory: they are this
-- append-only record, and "two consecutive failures" is a query over it. A restart loses nothing,
-- a retry cannot double count, and an incident can be reconstructed attempt by attempt.
--
-- Each row names what was tried and what happened. `factor` is which credential was checked,
-- `outcome` is one of four states, and an attempt always carries its origin address because IP
-- based rate limiting is a requirement in the same section.
--
-- An attempt against an address that has no account cannot store `user_id`, and storing the address
-- itself would hand the platform a table of strangers' emails. It stores `email_hash` instead: a
-- hash of the submitted address, enough to throttle repeated probing of one address, and useless
-- for anything else. The two identity columns are mutually exclusive by check, so a row is never
-- ambiguous about whether the account was known.
--
-- `created_at` is the attempt instant. The audit columns already store it, and a second
-- `attempted_at` column would be two claims about one moment.
--
-- Rows are facts, so a later STEP may delete old ones for retention, but no migration edits one.

begin;

create table public.login_attempts (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid,
  email_hash text,
  factor text not null,
  outcome text not null,
  ip_address inet not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint login_attempts_pkey primary key (id),
  constraint login_attempts_company_fkey foreign key (company_id) references public.companies (id),
  constraint login_attempts_user_fkey foreign key (user_id) references public.users (id),
  constraint login_attempts_factor_check check (factor in ('password', 'totp')),
  constraint login_attempts_outcome_check check (
    outcome in ('failed', 'succeeded', 'blocked', 'challenged')
  ),
  constraint login_attempts_identity_check check (user_id is not null or email_hash is not null),
  constraint login_attempts_identity_known_check check (
    user_id is null or email_hash is null
  ),
  constraint login_attempts_email_hash_check check (
    email_hash is null or email_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint login_attempts_ip_address_check check (family(ip_address) in (4, 6)),
  constraint login_attempts_user_agent_check check (
    user_agent is null or char_length(user_agent) between 1 and 512
  ),
  constraint login_attempts_version_positive_check check (version > 0),
  constraint login_attempts_updated_after_creation_check check (updated_at >= created_at),
  constraint login_attempts_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.login_attempts is
  'One authentication attempt per row. The failed attempt counters of section 22 are a query over this table.';

comment on column public.login_attempts.company_id is
  'Tenant of the account when the attempt named a known account, or null for an unknown address.';

comment on column public.login_attempts.user_id is
  'The account that was attempted, or null when the address has no account.';

comment on column public.login_attempts.email_hash is
  'Hex hash of the submitted address for an unknown account. Never the address itself.';

comment on column public.login_attempts.factor is
  'Which credential was checked: password or totp. Two consecutive failures of either lock the account.';

comment on column public.login_attempts.outcome is
  'failed, succeeded, blocked (correct credentials refused because the account is locked) or challenged.';

comment on column public.login_attempts.ip_address is
  'Origin of the attempt. Required, because IP rate limiting applies to every authentication endpoint.';

comment on column public.login_attempts.user_agent is
  'Client user agent, at most 512 characters. Shown in the lock alert and used for review.';

comment on column public.login_attempts.created_at is
  'The attempt instant. This is the event time; the table has no second timestamp.';

-- The counter query: consecutive failures for one account since its last success.
create index login_attempts_user_idx
  on public.login_attempts (user_id, created_at desc)
  where user_id is not null and deleted_at is null;

-- The IP rate limit: how many attempts this address made in the last window.
create index login_attempts_ip_idx
  on public.login_attempts (ip_address, created_at desc)
  where deleted_at is null;

-- Throttling one address that has no account, without knowing whose address it is.
create index login_attempts_email_idx
  on public.login_attempts (email_hash, created_at desc)
  where email_hash is not null and deleted_at is null;

-- Retention: the job that deletes attempts older than the configured window.
create index login_attempts_created_idx
  on public.login_attempts (created_at)
  where deleted_at is null;

create trigger login_attempts_set_row_metadata
  before update on public.login_attempts
  for each row
  execute function public.set_row_metadata();

alter table public.login_attempts enable row level security;

create policy login_attempts_default_deny
  on public.login_attempts
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
