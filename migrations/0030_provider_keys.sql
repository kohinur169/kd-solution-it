-- path: migrations/0030_provider_keys.sql
-- STEP 023 - the encrypted provider keys of section 6 and section 29.
--
-- "Keys are AES-256-GCM encrypted before storage. The encryption key exists only in environment
-- variables." The row therefore carries three pieces of ciphertext - the value, its initialisation
-- vector and its tag - plus `encryption_key_version`, and the plaintext key is never a column here
-- and never a column anywhere else. `0003_users.sql` stores the TOTP secret the same way, so the
-- platform has one shape for a secret at rest and not two.
--
-- "After saving, a full key is never shown again. Only the last characters and last updated time are
-- shown." `key_last_four` is that tail and `updated_at` is that time. `key_fingerprint` is the
-- SHA-256 of the plaintext, which is how the panel refuses the same key twice without keeping it.
--
-- "A provider cannot be enabled when its connection test fails." A key may only be `active` with
-- `last_test_ok = true` and the instant of the test, and the guard below refuses a rewritten secret:
-- a key that must change is disabled and rotated, which is section 29's procedure - add the new key,
-- test it, activate it, then disable the old one.
--
-- The keys are the platform's master keys, entered in the super admin gateway page, so `company_id`
-- is null on every row as it is on the provider catalogue. A merchant's own provider account is a
-- different object and is not this table.

begin;

create function public.provider_keys_guard_secret()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider_id is distinct from old.provider_id
     or new.mode is distinct from old.mode
     or new.key_last_four is distinct from old.key_last_four
     or new.key_fingerprint is distinct from old.key_fingerprint then
    raise exception 'a provider key keeps its identity; disable it and add the next key'
      using errcode = 'check_violation';
  end if;

  if (new.key_ciphertext is distinct from old.key_ciphertext
      or new.key_iv is distinct from old.key_iv
      or new.key_tag is distinct from old.key_tag)
     and new.encryption_key_version <= old.encryption_key_version then
    raise exception 'a provider key is re-encrypted only under a new key version'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.provider_keys_guard_secret() is
  'Freezes the identity of a key and allows new ciphertext only under a higher key version.';

create table public.provider_keys (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  provider_id uuid not null,
  label text not null,
  mode text not null default 'test',
  key_last_four text not null,
  key_fingerprint text not null,
  key_ciphertext text not null,
  key_iv text not null,
  key_tag text not null,
  encryption_key_version integer not null default 1,
  status text not null default 'disabled',
  activated_at timestamptz,
  disabled_at timestamptz,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_detail text,
  last_used_at timestamptz,
  rotated_from_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint provider_keys_pkey primary key (id),
  constraint provider_keys_company_fkey foreign key (company_id) references public.companies (id),
  constraint provider_keys_provider_fkey foreign key (provider_id)
    references public.payment_providers (id),
  constraint provider_keys_rotated_from_fkey foreign key (rotated_from_id)
    references public.provider_keys (id),
  constraint provider_keys_platform_check check (company_id is null),
  constraint provider_keys_mode_check check (mode in ('test', 'live')),
  constraint provider_keys_label_check check (
    char_length(label) between 1 and 80 and label = btrim(label)
  ),
  constraint provider_keys_last_four_check check (key_last_four ~ '^[A-Za-z0-9]{4}$'),
  constraint provider_keys_fingerprint_check check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint provider_keys_ciphertext_check check (
    char_length(key_ciphertext) between 16 and 8192
  ),
  constraint provider_keys_iv_check check (char_length(key_iv) between 12 and 64),
  constraint provider_keys_tag_check check (char_length(key_tag) between 16 and 64),
  constraint provider_keys_version_check check (encryption_key_version between 1 and 999),
  constraint provider_keys_status_check check (status in ('active', 'disabled')),
  constraint provider_keys_active_check check (
    (status = 'active') = (activated_at is not null)
  ),
  constraint provider_keys_disabled_check check (
    (status = 'disabled') = (disabled_at is not null)
  ),
  constraint provider_keys_test_check check (
    status <> 'active' or (last_test_ok is true and last_tested_at is not null)
  ),
  constraint provider_keys_test_detail_check check (
    last_test_detail is null
    or (
      char_length(last_test_detail) between 1 and 280
      and last_test_detail = btrim(last_test_detail)
    )
  ),
  constraint provider_keys_row_version_check check (version > 0),
  constraint provider_keys_updated_check check (updated_at >= created_at),
  constraint provider_keys_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.provider_keys is
  'AES-256-GCM encrypted provider credentials, with only their last four characters readable.';

comment on column public.provider_keys.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.provider_keys.company_id is
  'Null on every row: these are the platform master keys of the section 6 gateway page.';

comment on column public.provider_keys.provider_id is
  'The provider the key belongs to. Never changes; a key is replaced, not rewritten.';

comment on column public.provider_keys.label is
  'What the super admin calls this key, trimmed, 1 to 80 characters.';

comment on column public.provider_keys.mode is
  'test or live. Section 8 keeps the two apart, so one provider holds one active key per mode.';

comment on column public.provider_keys.key_last_four is
  'The only characters of the key a screen may show, exactly four of them.';

comment on column public.provider_keys.key_fingerprint is
  'SHA-256 of the plaintext key, so a duplicate key is refused without storing the key.';

comment on column public.provider_keys.key_ciphertext is
  'AES-256-GCM ciphertext of the key. The encryption key lives only in the environment.';

comment on column public.provider_keys.key_iv is
  'Initialisation vector of that ciphertext, never reused for the same key version.';

comment on column public.provider_keys.key_tag is
  'Authentication tag of that ciphertext, so a tampered value fails to decrypt.';

comment on column public.provider_keys.encryption_key_version is
  'Which environment encryption key protects this row; raising it allows re-encryption.';

comment on column public.provider_keys.status is
  'active while the provider may use this key, disabled once it is replaced.';

comment on column public.provider_keys.activated_at is
  'Set exactly when the status is active, after a passing connection test.';

comment on column public.provider_keys.disabled_at is
  'Set exactly when the status is disabled.';

comment on column public.provider_keys.last_tested_at is
  'When the connection test last ran with this key.';

comment on column public.provider_keys.last_test_ok is
  'The outcome of that test. An active key must carry true here.';

comment on column public.provider_keys.last_test_detail is
  'The failure detail, at most 280 characters, so no key can be pasted into it.';

comment on column public.provider_keys.last_used_at is
  'When the adapter last called the provider with this key.';

comment on column public.provider_keys.rotated_from_id is
  'The key this one replaced, at most once, so a rotation is one link and not a rewrite.';

comment on column public.provider_keys.created_at is
  'When the key was entered.';

comment on column public.provider_keys.updated_at is
  'Set by the provider_keys_set_row_metadata trigger on every update.';

comment on column public.provider_keys.deleted_at is
  'Soft delete marker. A removed key stays readable for the attempts it signed.';

comment on column public.provider_keys.version is
  'Optimistic locking counter. Incremented by the provider_keys_set_row_metadata trigger.';

-- The same secret cannot be entered twice for one provider.
create unique index provider_keys_fingerprint_key
  on public.provider_keys (provider_id, key_fingerprint)
  where deleted_at is null;

-- One active key per provider per mode: the rotation of section 29 has to disable the old one first.
create unique index provider_keys_active_key
  on public.provider_keys (provider_id, mode)
  where status = 'active' and deleted_at is null;

-- A key replaces at most one predecessor, so a rotation cannot fork.
create unique index provider_keys_rotation_key
  on public.provider_keys (rotated_from_id)
  where rotated_from_id is not null;

-- The gateway page: the keys of one provider in one mode.
create index provider_keys_provider_idx
  on public.provider_keys (provider_id, mode, status)
  where deleted_at is null;

create trigger provider_keys_guard_secret
  before update on public.provider_keys
  for each row
  execute function public.provider_keys_guard_secret();

create trigger provider_keys_set_row_metadata
  before update on public.provider_keys
  for each row
  execute function public.set_row_metadata();

alter table public.provider_keys enable row level security;

create policy provider_keys_default_deny
  on public.provider_keys
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
