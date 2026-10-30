-- path: migrations/0003_users.sql
-- STEP 013 - accounts.
--
-- A `users` row is a person who can sign in. It is not a company and not a client: a client is a
-- tokenized link with no login (feature list section 2), so a client never becomes a user row.
--
-- `company_id` is nullable because a platform office role (super_admin, ceo, compliance_kyc,
-- finance_ops, support, blogger) does not belong to one merchant company, while an owner does.
-- The foreign key keeps a real tenant honest, and the STEP that assigns roles keeps the two sides
-- consistent.
--
-- One person holds exactly one account (section 4), so `email` is stored lowercase, is unique for
-- ever, and a closed account keeps its address reserved. The remaining duplicate signals -
-- identity document hash, tax id, bank fingerprint, legal name with date of birth - belong to KYC
-- (STEP 028), not to this row.
--
-- TOTP is mandatory for every role that can sign in (section 22), and no later migration STEP
-- names a home for it, so the encrypted secret, the confirmation instant and the backup code
-- hashes live here. The secret is stored as AES-256-GCM ciphertext; the key stays in the
-- environment and never in this table. The codes are hashes in a bounded array, because a set is
-- read and replaced as a whole and never queried by value.
--
-- The login lock is deliberately not here: a lock is temporary and self clearing, a suspension is
-- an office decision. STEP 016 owns the lock table.

begin;

create table public.users (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  email text not null,
  phone text,
  full_name text not null,
  password_hash text not null,
  password_updated_at timestamptz not null default now(),
  email_verified_at timestamptz,
  totp_secret_ciphertext text,
  totp_confirmed_at timestamptz,
  backup_code_hashes jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint users_pkey primary key (id),
  constraint users_company_fkey foreign key (company_id) references public.companies (id),
  constraint users_email_format_check check (
    char_length(email) between 5 and 254
    and email = lower(email)
    and email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
  ),
  constraint users_phone_format_check check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint users_full_name_check check (
    char_length(full_name) between 1 and 120
    and full_name = btrim(full_name)
  ),
  constraint users_password_hash_check check (char_length(password_hash) between 20 and 255),
  constraint users_totp_secret_check check (
    totp_secret_ciphertext is null or char_length(totp_secret_ciphertext) between 1 and 512
  ),
  constraint users_totp_confirmation_check check (
    totp_confirmed_at is null or totp_secret_ciphertext is not null
  ),
  constraint users_backup_code_hashes_check check (
    jsonb_typeof(backup_code_hashes) = 'array' and jsonb_array_length(backup_code_hashes) <= 20
  ),
  constraint users_status_check check (status in ('active', 'suspended', 'closed')),
  constraint users_email_verified_after_creation_check
    check (email_verified_at is null or email_verified_at >= created_at),
  constraint users_version_positive_check check (version > 0),
  constraint users_updated_after_creation_check check (updated_at >= created_at),
  constraint users_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.users is
  'A person who can sign in. Office staff have no company; an owner belongs to one company.';

comment on column public.users.company_id is
  'Tenant of an owner account, or null for platform office staff. References companies(id).';

comment on column public.users.email is
  'Lowercase sign in address. Unique for ever, so one person cannot hold two accounts.';

comment on column public.users.phone is
  'Optional E.164 phone number. A duplicate signal for the one person one account rule.';

comment on column public.users.full_name is
  'Person name as the platform shows it, trimmed, 1 to 120 characters.';

comment on column public.users.password_hash is
  'Password hash from the auth STEP. Never a password, never a reversible value.';

comment on column public.users.password_updated_at is
  'When the password last changed, so a later STEP can invalidate older sessions.';

comment on column public.users.email_verified_at is
  'When the address was verified, or null until then.';

comment on column public.users.totp_secret_ciphertext is
  'AES-256-GCM ciphertext of the TOTP secret. The key lives only in the environment.';

comment on column public.users.totp_confirmed_at is
  'When the first TOTP code was accepted. Never set without a secret.';

comment on column public.users.backup_code_hashes is
  'Hashes of the current TOTP backup codes, at most 20, replaced as a whole.';

comment on column public.users.status is
  'active, suspended or closed. A login lock is a separate, temporary table owned by STEP 016.';

comment on column public.users.deleted_at is
  'Soft close marker. The row stays, and its email stays reserved.';

-- One account per address, permanently, including closed accounts.
create unique index users_email_key on public.users (email);

-- The people of one company, newest first.
create index users_company_idx on public.users (company_id, created_at desc) where deleted_at is null;

create trigger users_set_row_metadata
  before update on public.users
  for each row
  execute function public.set_row_metadata();

alter table public.users enable row level security;

create policy users_default_deny
  on public.users
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
