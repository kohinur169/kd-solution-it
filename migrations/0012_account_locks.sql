-- path: migrations/0012_account_locks.sql
-- STEP 016 - the account lock of section 22.
--
-- "Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours."
-- The attempts are recorded in `login_attempts`; this table is the resulting state. It is one row
-- per lock, and it is the only place that decides whether a sign-in is refused, which is why a
-- correct password during a lock does not help and changing the password cannot clear it: nothing
-- in the `users` table can reach this one.
--
-- The two hours are a constraint, not a convention: `expires_at` defaults to `locked_at + 2 hours`
-- and a check refuses anything later than that. A lock that outlives the policy is not storable.
--
-- A lock closes exactly one way. An office unlock sets `unlocked_at`, `unlocked_by` and
-- `unlock_note`, and the check requires `owner_contact_confirmed_at` first, because section 22 says
-- the unlock happens "only after contact with the owner is confirmed by email". The natural expiry
-- sets `expired_at`, and a check refuses an expiry before `expires_at`. The two closures are
-- mutually exclusive, so a row always says plainly whether a person or the clock ended it.
--
-- `owner_alerted_at` records that the lock alert email of section 23 was sent, so a missing alert is
-- a queryable fact and the retry job can find it, rather than an assumption about code paths.
--
-- One account has at most one open lock, enforced by a partial unique index. A closed lock stays as
-- history, so the same account can be locked again later without touching the old row.

begin;

create table public.account_locks (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  triggered_by text not null,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  owner_alerted_at timestamptz,
  owner_contact_confirmed_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid,
  unlock_note text,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint account_locks_pkey primary key (id),
  constraint account_locks_company_fkey foreign key (company_id) references public.companies (id),
  constraint account_locks_user_fkey foreign key (user_id) references public.users (id),
  constraint account_locks_unlocked_by_fkey foreign key (unlocked_by) references public.users (id),
  constraint account_locks_triggered_by_check check (triggered_by in ('password', 'totp')),
  constraint account_locks_window_check check (
    expires_at > locked_at and expires_at <= locked_at + interval '2 hours'
  ),
  constraint account_locks_alerted_check check (
    owner_alerted_at is null or owner_alerted_at >= locked_at
  ),
  constraint account_locks_contact_check check (
    owner_contact_confirmed_at is null or owner_contact_confirmed_at >= locked_at
  ),
  constraint account_locks_unlock_pair_check check (
    (unlocked_at is null) = (unlocked_by is null)
  ),
  constraint account_locks_unlock_contact_check check (
    unlocked_at is null or owner_contact_confirmed_at is not null
  ),
  constraint account_locks_unlock_time_check check (
    unlocked_at is null or unlocked_at >= locked_at
  ),
  constraint account_locks_closure_check check (
    unlocked_at is null or expired_at is null
  ),
  constraint account_locks_expiry_time_check check (
    expired_at is null or expired_at >= expires_at
  ),
  constraint account_locks_unlock_note_check check (
    unlock_note is null or char_length(unlock_note) between 1 and 280
  ),
  constraint account_locks_version_positive_check check (version > 0),
  constraint account_locks_updated_after_creation_check check (updated_at >= created_at),
  constraint account_locks_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.account_locks is
  'One lock per row. An open lock refuses every sign-in for its account until it is unlocked or expires.';

comment on column public.account_locks.company_id is
  'Tenant of the locked account.';

comment on column public.account_locks.user_id is
  'The locked account. A closed lock stays as history so the account can be locked again.';

comment on column public.account_locks.triggered_by is
  'Which factor reached two consecutive failures: password or totp.';

comment on column public.account_locks.locked_at is
  'When the lock started. The attempt that triggered it is in login_attempts at the same instant.';

comment on column public.account_locks.expires_at is
  'When the two hour lock ends by itself. Never later than locked_at plus two hours.';

comment on column public.account_locks.owner_alerted_at is
  'When the lock alert email was sent to the owner. Null means it is still owed.';

comment on column public.account_locks.owner_contact_confirmed_at is
  'When the office confirmed contact with the owner. An unlock is refused without it.';

comment on column public.account_locks.unlocked_at is
  'When an office user unlocked the account, or null while the lock is open or expired.';

comment on column public.account_locks.unlocked_by is
  'The office user who unlocked, set exactly with unlocked_at.';

comment on column public.account_locks.unlock_note is
  'What the officer verified, at most 280 characters. Never a secret.';

comment on column public.account_locks.expired_at is
  'When the two hours ran out and the lock was closed by time, never before expires_at.';

-- One open lock per account. A lock closes by unlock or by expiry; closed rows free the account.
create unique index account_locks_live_key
  on public.account_locks (user_id)
  where unlocked_at is null and expired_at is null and deleted_at is null;

-- The sweep that closes locks whose two hours ran out, and the reminder for unsent alerts.
create index account_locks_expiry_idx
  on public.account_locks (expires_at)
  where unlocked_at is null and expired_at is null and deleted_at is null;

create trigger account_locks_set_row_metadata
  before update on public.account_locks
  for each row
  execute function public.set_row_metadata();

alter table public.account_locks enable row level security;

create policy account_locks_default_deny
  on public.account_locks
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
