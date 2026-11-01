-- path: migrations/0010_sessions.sql
-- STEP 015 - sessions bound to a device proof.
--
-- Section 22 (LR-022) describes one mechanism in five parts: a session-bound cookie, a rotating
-- token, replay detection that revokes the whole session family, extra verification on a new
-- device and instant revocation. This table is where all five meet.
--
-- The token itself is never stored. The cookie carries a random token, the server hashes it and
-- looks the row up by `token_hash`, so a database leak yields no usable cookie and a comparison
-- never touches plaintext. The row is bound to `device_proof_key_id`, which is why a cookie copied
-- to an attacker's machine fails: the copied cookie names a device whose private key the attacker
-- does not have.
--
-- Every rotation inserts a new row that copies `family_id` and names its parent in
-- `rotated_from_session_id`. That makes "the whole session family" a single predicate, and it
-- makes a fork visible: a partial unique index allows one child per parent, so a second rotation of
-- the same session cannot exist. When a token that was already rotated is presented again, the
-- service records `replay_detected_at` and revokes the family; a check here forces that pairing so
-- a replay can never be filed as a quiet expiry.
--
-- A session also remembers how strong it currently is: `mfa_verified_at` when 2FA was satisfied,
-- `reauthenticated_at` when the user last reauthenticated for a sensitive action. The auth layer
-- compares those instants with its configured freshness window; a boolean would not age.
--
-- `ip_address` and `user_agent` feed the new device alert and anomaly review. They are personal
-- data: the STEP that writes them owns their retention.

begin;

create table public.sessions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  device_proof_key_id uuid not null,
  token_hash text not null,
  family_id uuid not null default public.uuid_generate_v7(),
  rotated_from_session_id uuid,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  mfa_verified_at timestamptz,
  reauthenticated_at timestamptz,
  ip_address inet,
  user_agent text,
  revoked_at timestamptz,
  revocation_reason text,
  replay_detected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint sessions_pkey primary key (id),
  constraint sessions_company_fkey foreign key (company_id) references public.companies (id),
  constraint sessions_user_fkey foreign key (user_id) references public.users (id),
  constraint sessions_user_device_fkey foreign key (user_id, device_proof_key_id)
    references public.device_proof_keys (user_id, id),
  constraint sessions_rotated_from_fkey foreign key (rotated_from_session_id)
    references public.sessions (id),
  constraint sessions_token_hash_check check (token_hash ~ '^[A-Za-z0-9_-]{43,128}$'),
  constraint sessions_expiry_check check (expires_at > issued_at),
  constraint sessions_last_seen_check check (last_seen_at >= issued_at),
  constraint sessions_revocation_pair_check check (
    (revoked_at is null) = (revocation_reason is null)
  ),
  constraint sessions_revocation_time_check check (
    revoked_at is null or revoked_at >= issued_at
  ),
  constraint sessions_revocation_reason_check check (
    revocation_reason is null or revocation_reason in (
      'SIGNED_OUT', 'ROTATED', 'REPLAY_DETECTED', 'FAMILY_REVOKED',
      'ADMIN_REVOKED', 'PASSWORD_CHANGED', 'DEVICE_REVOKED'
    )
  ),
  constraint sessions_replay_check check (
    replay_detected_at is null
    or (revoked_at is not null and revocation_reason = 'REPLAY_DETECTED'
        and replay_detected_at >= issued_at)
  ),
  constraint sessions_mfa_verified_check check (
    mfa_verified_at is null or mfa_verified_at >= issued_at
  ),
  constraint sessions_reauthenticated_check check (
    reauthenticated_at is null or reauthenticated_at >= issued_at
  ),
  constraint sessions_user_agent_check check (
    user_agent is null or char_length(user_agent) between 1 and 512
  ),
  constraint sessions_version_positive_check check (version > 0),
  constraint sessions_updated_after_creation_check check (updated_at >= created_at),
  constraint sessions_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.sessions is
  'One live or ended session. Rotations of one login share family_id; the token itself is never stored.';

comment on column public.sessions.company_id is
  'Tenant of the signed in account, or null for platform staff.';

comment on column public.sessions.user_id is
  'The account this session signs in as.';

comment on column public.sessions.device_proof_key_id is
  'The device whose proof key must sign each request. The composite key keeps it on this account.';

comment on column public.sessions.token_hash is
  'Hash of the rotating session token. Unique, so a token identifies exactly one row.';

comment on column public.sessions.family_id is
  'Shared by every rotation of one login. Revoking the family is one update on this column.';

comment on column public.sessions.rotated_from_session_id is
  'The session this row replaced. One child per parent, so a fork cannot be stored.';

comment on column public.sessions.issued_at is
  'When this rotation was issued, which is also the start of its activity window.';

comment on column public.sessions.expires_at is
  'Absolute expiry of this rotation. Sliding renewal is a new rotation, not an update.';

comment on column public.sessions.mfa_verified_at is
  'When 2FA was satisfied for this session, or null while the session is not yet two factor.';

comment on column public.sessions.reauthenticated_at is
  'When the user last reauthenticated for a sensitive action. The auth layer ages this value.';

comment on column public.sessions.ip_address is
  'Client address at issue and last use. Personal data, kept for the new device alert.';

comment on column public.sessions.user_agent is
  'Client user agent, at most 512 characters. Personal data, kept for anomaly review.';

comment on column public.sessions.revocation_reason is
  'Why the session ended, from a closed vocabulary. Set exactly when revoked_at is set.';

comment on column public.sessions.replay_detected_at is
  'When an already rotated token was presented again. Always paired with a replay revocation.';

-- The cookie lookup, and the guarantee that one token points at one session.
create unique index sessions_token_hash_key on public.sessions (token_hash);

-- "Your active sessions" for one account.
create index sessions_user_idx on public.sessions (user_id, revoked_at)
  where deleted_at is null;

-- Revocation of a whole family after a replay.
create index sessions_family_idx on public.sessions (family_id);

-- The cleanup job that ends expired sessions.
create index sessions_expiry_idx on public.sessions (expires_at)
  where revoked_at is null and deleted_at is null;

-- Revoking every session of a lost device.
create index sessions_device_idx on public.sessions (device_proof_key_id);

-- One rotation of a session, never two.
create unique index sessions_rotation_key on public.sessions (rotated_from_session_id)
  where rotated_from_session_id is not null;

create trigger sessions_set_row_metadata
  before update on public.sessions
  for each row
  execute function public.set_row_metadata();

alter table public.sessions enable row level security;

create policy sessions_default_deny
  on public.sessions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
