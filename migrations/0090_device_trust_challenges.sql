-- path: migrations/0090_device_trust_challenges.sql
-- STEP 052 - a new device has to be confirmed, and the confirmation has a shelf life.
--
-- Section 22 asks for "extra verification on a new device" and section 23 lists the new device alert
-- among the activity emails. `0009_device_proof_keys.sql` already carries the state this needs -
-- `trusted_at` is null on every row until the owner confirms the device - and `0061` already has the
-- `new_device_alert` template key. What does not exist is the record of *the attempt*: which device
-- asked, which alert told the owner, how many codes were tried, and when the asking stops.
--
-- Without that record the platform has two bad options: refuse an untrusted device for ever, or
-- trust it on any correct code with unlimited attempts. This table is the third option, and every
-- column is one of the four questions a confirmation has to answer:
--
--   * **which device** - `device_proof_key_id`, through the composite key into
--     `device_proof_keys (user_id, id)`, so a challenge can never name a device of another account;
--   * **which alert** - `alert_send_id` into `email_send_logs`, unique, so one challenge is one
--     email and an owner cannot be told twice about the same device;
--   * **how many tries** - `attempts` against `max_attempts`, with `0090`'s checks keeping the count
--     inside its budget so a wrong code cannot be retried for ever;
--   * **until when** - `expires_at` inside a hard ceiling, and two ways to end: `consumed_at` when
--     the code was right, `revoked_at` when a later challenge replaced this one.
--
-- A partial unique index allows exactly one live challenge per device. A merchant who reloads the
-- screen, opens a second tab or signs in again does not mint a second challenge, and a device that
-- was trusted ten minutes ago cannot be brought back to "new" by an old row.
--
-- The alert link is nullable on purpose: a deployment whose email settings are not configured yet
-- still records the challenge (with no email), and the office that configures sending later can see
-- which devices were confirmed without an alert. A row that names an alert names exactly one.

begin;

create table public.device_trust_challenges (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  device_proof_key_id uuid not null,
  alert_send_id uuid,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint device_trust_challenges_pkey primary key (id),
  constraint device_trust_challenges_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint device_trust_challenges_user_fkey foreign key (user_id)
    references public.users (id),
  constraint device_trust_challenges_user_device_fkey foreign key (user_id, device_proof_key_id)
    references public.device_proof_keys (user_id, id),
  constraint device_trust_challenges_alert_fkey foreign key (alert_send_id)
    references public.email_send_logs (id),
  constraint device_trust_challenges_window_check check (
    expires_at > issued_at and expires_at <= issued_at + interval '24 hours'
  ),
  constraint device_trust_challenges_attempts_check check (
    attempts between 0 and 10 and max_attempts between 1 and 10 and attempts <= max_attempts
  ),
  constraint device_trust_challenges_consumed_check check (
    consumed_at is null or (consumed_at >= issued_at and consumed_at <= expires_at)
  ),
  constraint device_trust_challenges_revoked_check check (
    revoked_at is null or revoked_at >= issued_at
  ),
  constraint device_trust_challenges_end_check check (
    consumed_at is null or revoked_at is null
  ),
  constraint device_trust_challenges_version_positive_check check (version > 0),
  constraint device_trust_challenges_updated_after_creation_check check (updated_at >= created_at),
  constraint device_trust_challenges_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.device_trust_challenges is
  'One attempt to trust a new device: which device, which alert, how many codes, until when.';

comment on column public.device_trust_challenges.company_id is
  'Tenant of the account, or null for platform staff.';

comment on column public.device_trust_challenges.user_id is
  'The account whose device is being confirmed.';

comment on column public.device_trust_challenges.device_proof_key_id is
  'The device row this challenge is about. The composite key keeps it on this account.';

comment on column public.device_trust_challenges.alert_send_id is
  'The new device alert queued for this challenge, or null when no sending method is configured.';

comment on column public.device_trust_challenges.attempts is
  'Codes tried against this challenge. A wrong code spends one; the budget bounds a guess.';

comment on column public.device_trust_challenges.expires_at is
  'When the challenge stops being answerable, at most a day after it was issued.';

comment on column public.device_trust_challenges.consumed_at is
  'When the second factor was accepted and the device became trusted.';

comment on column public.device_trust_challenges.revoked_at is
  'When a later challenge replaced this one, for example after the device was revoked and enrolled again.';

-- One live challenge per device: a reload cannot mint a second one.
create unique index device_trust_challenges_live_device_key
  on public.device_trust_challenges (device_proof_key_id)
  where consumed_at is null and revoked_at is null and deleted_at is null;

-- One challenge per alert, so an owner is never told twice about the same device.
create unique index device_trust_challenges_alert_key
  on public.device_trust_challenges (alert_send_id)
  where alert_send_id is not null;

-- "Which devices are waiting for me" on the security screen of STEP 054.
create index device_trust_challenges_user_idx
  on public.device_trust_challenges (user_id, issued_at desc)
  where consumed_at is null and revoked_at is null and deleted_at is null;

-- The sweep that closes a challenge nobody answered.
create index device_trust_challenges_expiry_idx
  on public.device_trust_challenges (expires_at)
  where consumed_at is null and revoked_at is null and deleted_at is null;

create trigger device_trust_challenges_set_row_metadata
  before update on public.device_trust_challenges
  for each row
  execute function public.set_row_metadata();

alter table public.device_trust_challenges enable row level security;

create policy device_trust_challenges_default_deny
  on public.device_trust_challenges
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
