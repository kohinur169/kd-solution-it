-- path: migrations/0082_auth_challenges.sql
-- STEP 042 - the challenge that stands between a password and a session.
--
-- Section 22 makes a second factor mandatory for every account holding a role. That requirement
-- has one architectural consequence: the password step cannot hand out a session, because a
-- session is what "signed in" means, and an account that has not passed its second factor has not
-- signed in. The provider's exchange still returns a token pair - it has verified the password and
-- that is all it knows how to do - so the pair has to wait somewhere the browser cannot read.
--
-- It waits here. One row per challenge:
--
--   - `token_hash` is the hash of a random token the browser does hold. The row is found by hashing
--     what the browser presented, so a database leak yields no usable challenge, and the token
--     itself is never stored, exactly the rule `0010` follows for a session token.
--   - `secret_ciphertext` is the token pair from the provider, sealed with AES-256-GCM under
--     `ENCRYPTION_MASTER_KEY` and associated data naming the challenge. The browser holds an opaque
--     handle and never sees the pair until the code is accepted; the sealing is what makes the row
--     useless to anyone who can read the table without the environment.
--   - `attempt_count` counts rejected codes against this challenge, so a stranger with a stolen
--     password cannot try every six digit number. The two consecutive failures that lock an account
--     (section 22) are counted from `0011`, which already accepts `factor = 'totp'`; this counter is
--     the narrower one, scoped to one challenge.
--   - `consumed_at` makes a challenge single use. A code accepted twice would be a session issued
--     twice from one password entry, and the second one would be invisible to a person who had
--     already walked away from the keyboard.
--
-- `expires_at` is short because nothing here needs to outlive a sign in: a challenge that nobody
-- completed is debris, and the row is deleted by the retention job of the auth area rather than
-- kept for history. The audit chain records the sign in that the challenge produced, not the
-- challenge.
--
-- No policy is added beyond the default deny. The service reaches this table with the service role,
-- which bypasses row level security by design; a request never reads or writes it directly.

begin;

create table public.auth_challenges (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  purpose text not null,
  token_hash text not null,
  secret_ciphertext text not null,
  attempt_count integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint auth_challenges_pkey primary key (id),
  constraint auth_challenges_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint auth_challenges_user_fkey foreign key (user_id) references public.users (id),
  constraint auth_challenges_purpose_check check (purpose in ('two_factor')),
  constraint auth_challenges_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_challenges_secret_check check (
    char_length(secret_ciphertext) between 32 and 4096
  ),
  constraint auth_challenges_attempt_check check (attempt_count between 0 and 10),
  constraint auth_challenges_expiry_check check (expires_at > created_at),
  constraint auth_challenges_consumed_check check (
    consumed_at is null or consumed_at >= created_at
  ),
  constraint auth_challenges_version_positive_check check (version > 0),
  constraint auth_challenges_updated_after_creation_check check (updated_at >= created_at),
  constraint auth_challenges_deleted_after_creation_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.auth_challenges is
  'One pending second factor step: a hashed browser handle and the sealed provider token pair it unlocks.';

comment on column public.auth_challenges.user_id is
  'The account whose password was accepted. The challenge can only ever produce a session for this account.';

comment on column public.auth_challenges.purpose is
  'What the challenge proves. two_factor is the sign in step of STEP 042.';

comment on column public.auth_challenges.token_hash is
  'SHA-256 hex of the opaque handle given to the browser. The handle itself is never stored.';

comment on column public.auth_challenges.secret_ciphertext is
  'AES-256-GCM box of the provider token pair, sealed under ENCRYPTION_MASTER_KEY with the challenge in the associated data.';

comment on column public.auth_challenges.attempt_count is
  'Rejected codes against this challenge. The account wide counter of section 22 lives in login_attempts.';

comment on column public.auth_challenges.expires_at is
  'When the challenge stops being usable. Shorter than a session, because it exists only to be completed.';

comment on column public.auth_challenges.consumed_at is
  'When the challenge was used. A consumed challenge cannot produce a second session.';

-- One live challenge per handle. A retired row does not block a new one, which is the same shape
-- `0080` uses for its settings keys.
create unique index auth_challenges_token_key
  on public.auth_challenges (token_hash)
  where deleted_at is null;

-- The completion path: the newest live challenge of one account, by handle.
create index auth_challenges_user_idx
  on public.auth_challenges (user_id, created_at desc)
  where deleted_at is null and consumed_at is null;

-- Retention: the job that removes challenges that expired without being completed.
create index auth_challenges_expires_idx
  on public.auth_challenges (expires_at)
  where deleted_at is null;

create trigger auth_challenges_set_row_metadata
  before update on public.auth_challenges
  for each row
  execute function public.set_row_metadata();

alter table public.auth_challenges enable row level security;

create policy auth_challenges_default_deny
  on public.auth_challenges
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
