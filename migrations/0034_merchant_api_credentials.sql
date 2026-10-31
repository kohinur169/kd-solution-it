-- path: migrations/0034_merchant_api_credentials.sql
-- STEP 023 - the merchant public API credentials of section 20.
--
-- "A public API exists for online store payments only." "Merchants create, revoke and regenerate API
-- credentials." "Full API keys and secrets are never displayed. After creation they are shown masked
-- only and never appear in UI, logs or error messages."
--
-- That sentence splits one credential into two secrets with two different storages, and this table
-- keeps them apart on purpose. The API key is only ever verified, so the row holds its SHA-256 in
-- `key_hash`, its visible prefix in `key_prefix` and its last four characters in `key_last_four`;
-- there is no ciphertext of it, because nothing ever needs to read it back. The webhook signing
-- secret must be used later to sign an outbound delivery, so it is stored as AES-256-GCM ciphertext
-- beside its own last four characters. Neither can be shown in full, which is the rule.
--
-- Regeneration is a rotation and not an edit: `rotated_from_id` is unique, so a credential replaces
-- at most one predecessor, and revoking sets `revoked_at` with a reason so the row stays readable for
-- the audit log of section 20 and the key exchange of a store integration.
--
-- `key_prefix` is lower case because section 20 shows it in a panel and a URL, and the mode is folded
-- into it in code; the database only refuses anything that is not a lower case slug.

begin;

create function public.merchant_api_credentials_guard_secret()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.mode is distinct from old.mode
     or new.key_prefix is distinct from old.key_prefix
     or new.key_last_four is distinct from old.key_last_four
     or new.key_hash is distinct from old.key_hash
     or new.signing_secret_last_four is distinct from old.signing_secret_last_four then
    raise exception 'a credential keeps its identity; revoke it and issue the next one'
      using errcode = 'check_violation';
  end if;

  if old.status = 'revoked' and new.status is distinct from old.status then
    raise exception 'a revoked credential stays revoked'
      using errcode = 'check_violation';
  end if;

  if (new.signing_secret_ciphertext is distinct from old.signing_secret_ciphertext
      or new.signing_secret_iv is distinct from old.signing_secret_iv
      or new.signing_secret_tag is distinct from old.signing_secret_tag)
     and new.encryption_key_version <= old.encryption_key_version then
    raise exception 'a signing secret is re-encrypted only under a new key version'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.merchant_api_credentials_guard_secret() is
  'Freezes a credential and allows new ciphertext only under a higher key version.';

create table public.merchant_api_credentials (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  label text not null,
  mode text not null default 'test',
  key_prefix text not null,
  key_last_four text not null,
  key_hash text not null,
  signing_secret_last_four text not null,
  signing_secret_ciphertext text not null,
  signing_secret_iv text not null,
  signing_secret_tag text not null,
  encryption_key_version integer not null default 1,
  status text not null default 'active',
  revoked_at timestamptz,
  revoke_reason text,
  last_used_at timestamptz,
  rotated_from_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint merchant_api_credentials_pkey primary key (id),
  constraint merchant_api_credentials_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint merchant_api_credentials_rotated_fkey foreign key (rotated_from_id)
    references public.merchant_api_credentials (id),
  constraint merchant_api_credentials_mode_check check (mode in ('test', 'live')),
  constraint merchant_api_credentials_label_check check (
    char_length(label) between 1 and 80 and label = btrim(label)
  ),
  constraint merchant_api_credentials_prefix_check check (
    key_prefix ~ '^[a-z][a-z0-9_]{1,15}$'
  ),
  constraint merchant_api_credentials_last_four_check check (key_last_four ~ '^[A-Za-z0-9]{4}$'),
  constraint merchant_api_credentials_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint merchant_api_credentials_secret_last_four_check check (
    signing_secret_last_four ~ '^[A-Za-z0-9]{4}$'
  ),
  constraint merchant_api_credentials_ciphertext_check check (
    char_length(signing_secret_ciphertext) between 16 and 8192
  ),
  constraint merchant_api_credentials_iv_check check (
    char_length(signing_secret_iv) between 12 and 64
  ),
  constraint merchant_api_credentials_tag_check check (
    char_length(signing_secret_tag) between 16 and 64
  ),
  constraint merchant_api_credentials_version_check check (encryption_key_version between 1 and 999),
  constraint merchant_api_credentials_status_check check (status in ('active', 'revoked')),
  constraint merchant_api_credentials_revoked_check check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  constraint merchant_api_credentials_reason_check check (
    (status = 'revoked'
      and revoke_reason is not null
      and char_length(revoke_reason) between 1 and 280
      and revoke_reason = btrim(revoke_reason))
    or (status = 'active' and revoke_reason is null)
  ),
  constraint merchant_api_credentials_row_version_check check (version > 0),
  constraint merchant_api_credentials_updated_check check (updated_at >= created_at),
  constraint merchant_api_credentials_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.merchant_api_credentials is
  'A merchant API key as a hash plus its visible tail, with the webhook signing secret encrypted.';

comment on column public.merchant_api_credentials.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.merchant_api_credentials.company_id is
  'The merchant the credential belongs to. One merchant may hold several.';

comment on column public.merchant_api_credentials.label is
  'What the merchant calls this credential, trimmed, 1 to 80 characters.';

comment on column public.merchant_api_credentials.mode is
  'test or live. Section 8 keeps the two sets of credentials apart.';

comment on column public.merchant_api_credentials.key_prefix is
  'The visible lower case prefix of the key, 2 to 16 characters, never the secret itself.';

comment on column public.merchant_api_credentials.key_last_four is
  'The only characters of the key a screen may show, exactly four of them.';

comment on column public.merchant_api_credentials.key_hash is
  'SHA-256 of the key. The key itself is never stored, because it is only ever verified.';

comment on column public.merchant_api_credentials.signing_secret_last_four is
  'The only characters of the signing secret a screen may show.';

comment on column public.merchant_api_credentials.signing_secret_ciphertext is
  'AES-256-GCM ciphertext of the signing secret, which must be read back to sign a delivery.';

comment on column public.merchant_api_credentials.signing_secret_iv is
  'Initialisation vector of that ciphertext.';

comment on column public.merchant_api_credentials.signing_secret_tag is
  'Authentication tag of that ciphertext.';

comment on column public.merchant_api_credentials.encryption_key_version is
  'Which environment encryption key protects the signing secret.';

comment on column public.merchant_api_credentials.status is
  'active until the merchant revokes the credential, and revoked afterwards for good.';

comment on column public.merchant_api_credentials.revoked_at is
  'Set exactly when the status is revoked.';

comment on column public.merchant_api_credentials.revoke_reason is
  'Why it was revoked, at most 280 characters, present exactly on a revoked credential.';

comment on column public.merchant_api_credentials.last_used_at is
  'When an API call last authenticated with this credential.';

comment on column public.merchant_api_credentials.rotated_from_id is
  'The credential this one replaced, at most once, so regeneration is a link.';

comment on column public.merchant_api_credentials.created_at is
  'When the credential was issued.';

comment on column public.merchant_api_credentials.updated_at is
  'Set by the merchant_api_credentials_set_row_metadata trigger on every update.';

comment on column public.merchant_api_credentials.deleted_at is
  'Soft delete marker. A removed credential stays readable for the calls it signed.';

comment on column public.merchant_api_credentials.version is
  'Optimistic locking counter. Incremented by the merchant_api_credentials_set_row_metadata trigger.';

-- A key hash is unique platform wide: two merchants can never hold the same secret.
create unique index merchant_api_credentials_hash_key
  on public.merchant_api_credentials (key_hash);

-- One label per merchant, case insensitive, among the live credentials.
create unique index merchant_api_credentials_label_key
  on public.merchant_api_credentials (company_id, lower(label))
  where deleted_at is null;

-- A credential replaces at most one predecessor.
create unique index merchant_api_credentials_rotation_key
  on public.merchant_api_credentials (rotated_from_id)
  where rotated_from_id is not null;

-- The merchant settings screen: the credentials of one merchant and mode.
create index merchant_api_credentials_company_idx
  on public.merchant_api_credentials (company_id, mode, status)
  where deleted_at is null;

create trigger merchant_api_credentials_guard_secret
  before update on public.merchant_api_credentials
  for each row
  execute function public.merchant_api_credentials_guard_secret();

create trigger merchant_api_credentials_set_row_metadata
  before update on public.merchant_api_credentials
  for each row
  execute function public.set_row_metadata();

alter table public.merchant_api_credentials enable row level security;

create policy merchant_api_credentials_default_deny
  on public.merchant_api_credentials
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
