-- path: migrations/0009_device_proof_keys.sql
-- STEP 015 - per device proof keys.
--
-- Section 22 (LR-022) requires a "per-device proof key" next to the session-bound cookie, and a
-- new device to be verified before it is trusted. This table is that key: the browser generates a
-- key pair, keeps the private half where a script cannot read it, and sends only the public half
-- here. Every session then names the key that was proven, so a stolen cookie copied to another
-- machine fails the signature check instead of becoming a second login.
--
-- A key is a device, not a login. It outlives sessions, it can be renamed (`label`), it is trusted
-- only after the owner confirms the new device by email and 2FA (`trusted_at`), and it is kept,
-- revoked, when the device is lost (`revoked_at`) rather than deleted, because the sessions that
-- were opened with it must stay explainable.
--
-- The fingerprint is the client and server agreed hash of the public key. It is unique per user
-- while the key is live, so the same browser cannot enrol twice; a revoked key may be replaced by
-- a fresh row, which keeps the revocation history instead of overwriting it.

begin;

create table public.device_proof_keys (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  fingerprint text not null,
  public_key text not null,
  algorithm text not null default 'ES256',
  label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  trusted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint device_proof_keys_pkey primary key (id),
  constraint device_proof_keys_company_fkey foreign key (company_id) references public.companies (id),
  constraint device_proof_keys_user_fkey foreign key (user_id) references public.users (id),
  constraint device_proof_keys_fingerprint_check check (
    fingerprint ~ '^[A-Za-z0-9_-]{43,128}$'
  ),
  constraint device_proof_keys_public_key_check check (
    public_key ~ '^[A-Za-z0-9_-]+$' and char_length(public_key) between 32 and 512
  ),
  constraint device_proof_keys_algorithm_check check (
    algorithm in ('ES256', 'ES384', 'EdDSA')
  ),
  constraint device_proof_keys_label_check check (
    label is null or (char_length(label) between 1 and 80 and label = btrim(label))
  ),
  constraint device_proof_keys_last_seen_check check (last_seen_at >= first_seen_at),
  constraint device_proof_keys_trusted_check check (
    trusted_at is null or trusted_at >= first_seen_at
  ),
  constraint device_proof_keys_revoked_check check (
    revoked_at is null or revoked_at >= first_seen_at
  ),
  constraint device_proof_keys_version_positive_check check (version > 0),
  constraint device_proof_keys_updated_after_creation_check check (updated_at >= created_at),
  constraint device_proof_keys_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.device_proof_keys is
  'One enrolled device per row. The public half of a proof key plus the trust state of that device.';

comment on column public.device_proof_keys.company_id is
  'Tenant of the account when the device belongs to one company, or null for platform staff.';

comment on column public.device_proof_keys.user_id is
  'The account this device signs in as. A key belongs to exactly one account.';

comment on column public.device_proof_keys.fingerprint is
  'Base64url hash of the public key. Unique per live key, so one browser enrols once.';

comment on column public.device_proof_keys.public_key is
  'Base64url encoded public key. The private half never leaves the browser.';

comment on column public.device_proof_keys.algorithm is
  'Proof key algorithm: ES256, ES384 or EdDSA.';

comment on column public.device_proof_keys.label is
  'Optional owner supplied name such as "Personal laptop". Trimmed, never a secret.';

comment on column public.device_proof_keys.first_seen_at is
  'When the device was first seen. The new device alert email reports this instant.';

comment on column public.device_proof_keys.trusted_at is
  'Null until the owner confirms the new device by email and 2FA.';

comment on column public.device_proof_keys.revoked_at is
  'When the device was revoked, for example when it was lost. The row stays as history.';

-- One live key per account and fingerprint; a revoked or deleted key frees the pair again.
create unique index device_proof_keys_live_key
  on public.device_proof_keys (user_id, fingerprint)
  where revoked_at is null and deleted_at is null;

-- The target of the sessions table's composite key: a session may only name a device of its own
-- account, which a plain device reference cannot express.
create unique index device_proof_keys_user_id_key
  on public.device_proof_keys (user_id, id);

-- "Which devices does this account have" for the security screen and for new device alerts.
create index device_proof_keys_user_idx
  on public.device_proof_keys (user_id)
  where revoked_at is null and deleted_at is null;

create trigger device_proof_keys_set_row_metadata
  before update on public.device_proof_keys
  for each row
  execute function public.set_row_metadata();

alter table public.device_proof_keys enable row level security;

create policy device_proof_keys_default_deny
  on public.device_proof_keys
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
