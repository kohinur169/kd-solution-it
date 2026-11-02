-- path: migrations/0080_platform_settings.sql
-- STEP 038 - the platform setting, and the one place a secret value is allowed to live.
--
-- Section 24 lets `super_admin` set the platform information from settings, section 22 runs
-- Cloudflare Turnstile on signup, login and password reset, and section 34 keeps the Turnstile
-- secret out of the environment: "Cloudflare Turnstile site and secret keys for the production
-- domain" is a go-live item an operator rotates, not a build artifact. Until this file there was
-- no table for such a value - `email_settings` holds one sender configuration and nothing else
-- does - so this file creates the registry.
--
-- Three decisions shape it:
--
--   1. A setting is a key and a typed JSON value. The key is a dotted lower case name
--      (`turnstile.enabled`), unique while the row is live, so a lookup is one index probe and a
--      second row for the same key is impossible rather than merely discouraged.
--   2. A secret setting stores no plaintext. `is_secret` switches the row to the AES-256-GCM
--      quartet the key tables of this platform already use - an initialisation vector, an
--      authentication tag and a ciphertext - and the check constraint makes the two shapes
--      mutually exclusive. The master key never reaches the database, so a dump of this table
--      yields no usable secret.
--   3. A setting belongs to the platform. `company_id` exists because every table carries it and
--      is checked null, exactly as `countries` does, because nothing here is a merchant's.
--
-- The guard freezes the key and the secrecy of a row: a key that could be renamed would orphan
-- every reader of the old name, and a secret that could be flipped to plaintext would be a value
-- with nobody watching it. A value changes with a version bump, which is the optimistic lock the
-- rest of the schema uses, and the service that changes it writes the audit row that section 2
-- requires - the database cannot sign, and rule 19 of the migrations book explains why the
-- signature lives in the service that holds the key.
--
-- The seed is one row and it is deliberately the closed side of the switch: `turnstile.enabled` is
-- false, so the signup route of STEP 038 refuses to create an account in production until an
-- operator turns it on with a stored secret, which is the go-live item of section 34. A seeded row
-- carries no audit entry, because the platform chain begins with the bootstrap of `0079` and this
-- file runs before any person exists.

begin;

-- Freeze what identifies a setting, so a reader's key never means two things.
create function public.platform_settings_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a platform setting is disabled, never removed'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.setting_key is distinct from old.setting_key then
    raise exception 'a platform setting keeps its key'
      using errcode = 'check_violation';
  end if;

  if new.is_secret is distinct from old.is_secret then
    raise exception 'a platform setting keeps its shape; store a new key instead'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from old.company_id then
    raise exception 'a platform setting belongs to the platform'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.platform_settings_guard_state() is
  'Freezes the key, the secrecy and the platform scope of a setting; a setting is never removed.';

create table public.platform_settings (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  setting_key text not null,
  value jsonb,
  is_secret boolean not null default false,
  secret_iv text,
  secret_tag text,
  secret_ciphertext text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint platform_settings_pkey primary key (id),
  constraint platform_settings_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint platform_settings_updated_by_fkey foreign key (updated_by)
    references public.users (id),
  constraint platform_settings_platform_check check (company_id is null),
  constraint platform_settings_key_check check (
    char_length(setting_key) between 3 and 64
    and setting_key ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'
  ),
  constraint platform_settings_shape_check check (
    (
      not is_secret
      and value is not null
      and secret_iv is null
      and secret_tag is null
      and secret_ciphertext is null
    )
    or (
      is_secret
      and value is null
      and secret_iv ~ '^[A-Za-z0-9_-]{16}$'
      and secret_tag ~ '^[A-Za-z0-9_-]{22}$'
      and char_length(secret_ciphertext) between 1 and 8192
      and secret_ciphertext ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  constraint platform_settings_version_positive_check check (version > 0),
  constraint platform_settings_updated_after_creation_check check (updated_at >= created_at),
  constraint platform_settings_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.platform_settings is
  'One platform setting: a dotted key and either a JSON value or an AES-256-GCM secret, never both.';

comment on column public.platform_settings.setting_key is
  'Dotted lower case key such as turnstile.enabled. Frozen after the row is written.';

comment on column public.platform_settings.value is
  'The JSON value of a non secret setting. Null for a secret, whose plaintext never reaches this table.';

comment on column public.platform_settings.is_secret is
  'True when the row holds a secret: the iv, tag and ciphertext triple, and no JSON value.';

comment on column public.platform_settings.secret_iv is
  'Base64url AES-256-GCM initialisation vector of 12 bytes.';

comment on column public.platform_settings.secret_tag is
  'Base64url AES-256-GCM authentication tag of 16 bytes.';

comment on column public.platform_settings.secret_ciphertext is
  'Base64url AES-256-GCM ciphertext. The master key is in the environment and never here.';

comment on column public.platform_settings.updated_by is
  'The super_admin who last changed the value, or null for the seed of 0080.';

-- One live row per key, so a reader never has to choose between two answers.
create unique index platform_settings_key_key
  on public.platform_settings (setting_key)
  where deleted_at is null;

-- The secret lookup: the rows an operator rotates, in key order.
create index platform_settings_secret_idx
  on public.platform_settings (setting_key)
  where is_secret and deleted_at is null;

create trigger platform_settings_guard_state
  before insert or update or delete on public.platform_settings
  for each row
  execute function public.platform_settings_guard_state();

create trigger platform_settings_set_row_metadata
  before update on public.platform_settings
  for each row
  execute function public.set_row_metadata();

alter table public.platform_settings enable row level security;

create policy platform_settings_default_deny
  on public.platform_settings
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- Section 24 gives the platform settings to super_admin alone: the value of a setting can point a
-- provider, an email sender or a switch that changes what every merchant sees.
create policy platform_settings_super_admin_all
  on public.platform_settings
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

-- The seed. Turnstile starts off, because a switch that starts on without a stored secret would
-- silently let every signup skip the check section 22 requires.
insert into public.platform_settings (setting_key, value, is_secret) values
  ('turnstile.enabled', 'false'::jsonb, false);

commit;
