-- path: migrations/0059_email_settings.sql
-- STEP 032 - the email sending configuration of section 23: one row per configuration, one
-- active at a time.
--
-- Section 23 asks for SMTP and for an API provider, with one sending method active at a time,
-- and for a successful test email before a configuration may be activated. The table keeps a
-- method and only that method's fields: `api_provider` and `api_endpoint` for `api`, and
-- `smtp_host`, `smtp_port` and `smtp_username` for `smtp`, so a half filled row cannot exist. The
-- fields of one method are all present or all absent, and the method check decides which of the
-- two sets a row may carry at all.
-- The API provider is a shape checked name rather than a closed list, because section 23 names
-- no provider; STEP 222 closes the list when it chooses one.
--
-- The secret is the ciphertext quartet of `provider_keys`: an encrypted credential, its iv, its
-- tag and the master key rotation that sealed it, with `aes-256-gcm` as the only cipher. No
-- column holds the plaintext, which is what "never shown in full after saving" means in a
-- schema rather than in a screen.
--
-- Activation is evidence, the way an active provider key is. `email_settings_test_check` refuses
-- `active` without `last_test_ok` true and its instant, and `email_settings_active_key` is a
-- partial unique index over the single value `active`, so the platform can never have two
-- senders. `draft` was never activated; `disabled` was, and carries the instant it stopped.
--
-- `email_settings_guard_state` freezes the connection and the sender identity while a row is
-- active, so a change needs the row disabled first, and it refuses to delete an active row,
-- because deleting one would leave the platform with no sender and no record of the one it had.

begin;

create function public.email_settings_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'active' and (
      new.method is distinct from old.method
      or new.api_provider is distinct from old.api_provider
      or new.api_endpoint is distinct from old.api_endpoint
      or new.smtp_host is distinct from old.smtp_host
      or new.smtp_port is distinct from old.smtp_port
      or new.smtp_secure is distinct from old.smtp_secure
      or new.smtp_username is distinct from old.smtp_username
      or new.credential_ciphertext is distinct from old.credential_ciphertext
      or new.credential_iv is distinct from old.credential_iv
      or new.credential_tag is distinct from old.credential_tag
      or new.encryption_key_version is distinct from old.encryption_key_version
      or new.from_address is distinct from old.from_address
      or new.from_name is distinct from old.from_name
      or new.reply_to is distinct from old.reply_to
    ) then
      raise exception 'a sending method is disabled before its connection changes'
        using errcode = 'check_violation';
    end if;

    if new.status = 'active' and new.activated_at is distinct from old.activated_at then
      raise exception 'an active sending method keeps its activation instant'
        using errcode = 'check_violation';
    end if;

    if old.status = 'active' and new.deleted_at is not null then
      raise exception 'a sending method is disabled before it is deleted'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.email_settings_guard_state() is
  'Disables a sending method before its connection changes, and refuses a delete while active.';

create table public.email_settings (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  method text not null,
  api_provider text,
  api_endpoint text,
  smtp_host text,
  smtp_port integer,
  smtp_secure boolean not null default true,
  smtp_username text,
  credential_ciphertext text not null,
  credential_iv text not null,
  credential_tag text not null,
  encryption_algorithm text not null default 'aes-256-gcm',
  encryption_key_version integer not null default 1,
  from_address text not null,
  from_name text not null,
  reply_to text,
  status text not null default 'draft',
  activated_at timestamptz,
  disabled_at timestamptz,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_detail text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint email_settings_pkey primary key (id),
  constraint email_settings_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint email_settings_created_by_fkey foreign key (created_by)
    references public.users (id),
  constraint email_settings_platform_check check (company_id is null),
  constraint email_settings_method_check check (method in ('smtp', 'api')),
  constraint email_settings_api_provider_check check (
    api_provider is null or api_provider ~ '^[a-z][a-z0-9_]{2,31}$'
  ),
  constraint email_settings_api_endpoint_check check (
    api_endpoint is null
    or (
      char_length(api_endpoint) between 12 and 200
      and api_endpoint ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(/[A-Za-z0-9._/-]*)?$'
    )
  ),
  constraint email_settings_smtp_host_check check (
    smtp_host is null
    or (
      char_length(smtp_host) between 3 and 253
      and smtp_host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
    )
  ),
  constraint email_settings_smtp_port_check check (
    smtp_port is null or smtp_port between 1 and 65535
  ),
  constraint email_settings_smtp_username_check check (
    smtp_username is null
    or (
      char_length(smtp_username) between 3 and 320
      and smtp_username = btrim(smtp_username)
    )
  ),
  constraint email_settings_api_fields_check check (
    (api_provider is null and api_endpoint is null)
    or (api_provider is not null and api_endpoint is not null)
  ),
  constraint email_settings_smtp_fields_check check (
    (smtp_host is null and smtp_port is null and smtp_username is null)
    or (smtp_host is not null and smtp_port is not null and smtp_username is not null)
  ),
  constraint email_settings_method_api_check check (
    (method = 'api') = (api_provider is not null)
  ),
  constraint email_settings_method_smtp_check check (
    (method = 'smtp') = (smtp_host is not null)
  ),
  constraint email_settings_ciphertext_check check (
    char_length(credential_ciphertext) between 16 and 8192
  ),
  constraint email_settings_iv_check check (char_length(credential_iv) between 12 and 64),
  constraint email_settings_tag_check check (char_length(credential_tag) between 16 and 64),
  constraint email_settings_algorithm_check check (encryption_algorithm = 'aes-256-gcm'),
  constraint email_settings_key_version_check check (encryption_key_version between 1 and 999),
  constraint email_settings_from_address_check check (
    char_length(from_address) between 3 and 320
    and from_address ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
  ),
  constraint email_settings_from_name_check check (
    char_length(from_name) between 1 and 80
    and from_name = btrim(from_name)
  ),
  constraint email_settings_reply_to_check check (
    reply_to is null
    or (
      char_length(reply_to) between 3 and 320
      and reply_to ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
    )
  ),
  constraint email_settings_status_check check (status in ('draft', 'active', 'disabled')),
  constraint email_settings_activated_check check (
    (status = 'active') = (activated_at is not null)
  ),
  constraint email_settings_disabled_check check (
    (status = 'disabled') = (disabled_at is not null)
  ),
  constraint email_settings_test_check check (
    status <> 'active' or (last_test_ok is true and last_tested_at is not null)
  ),
  constraint email_settings_test_detail_check check (
    last_test_detail is null
    or (
      char_length(last_test_detail) between 1 and 280
      and last_test_detail = btrim(last_test_detail)
    )
  ),
  constraint email_settings_instant_check check (
    (activated_at is null or activated_at >= created_at)
    and (disabled_at is null or disabled_at >= created_at)
    and (last_tested_at is null or last_tested_at >= created_at)
  ),
  constraint email_settings_updated_check check (updated_at >= created_at),
  constraint email_settings_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint email_settings_row_version_check check (version > 0)
);

comment on table public.email_settings is
  'One email sending configuration of section 23, with one row active at a time.';

comment on column public.email_settings.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.email_settings.company_id is
  'Always null: email is the platform sender of section 23, not a merchant setting.';

comment on column public.email_settings.method is
  'smtp or api, the two sending methods section 23 allows.';

comment on column public.email_settings.api_provider is
  'The API provider name, required by the api method; the closed list belongs to STEP 222.';

comment on column public.email_settings.api_endpoint is
  'The https endpoint of the API provider, required by the api method.';

comment on column public.email_settings.smtp_host is
  'The SMTP host, a lower case hostname, required by the smtp method.';

comment on column public.email_settings.smtp_port is
  'The SMTP port, 1 to 65535, required by the smtp method.';

comment on column public.email_settings.smtp_secure is
  'True when the connection starts with TLS, which section 23 expects of every sender.';

comment on column public.email_settings.smtp_username is
  'The SMTP user name, required by the smtp method; the password is the encrypted credential.';

comment on column public.email_settings.credential_ciphertext is
  'The AES-256-GCM encrypted password or API key. No plaintext copy exists in any column.';

comment on column public.email_settings.credential_iv is
  'The initialisation vector of that ciphertext, 12 to 64 characters.';

comment on column public.email_settings.credential_tag is
  'The authentication tag of that ciphertext, 16 to 64 characters.';

comment on column public.email_settings.encryption_algorithm is
  'Fixed to aes-256-gcm, the only cipher the key tables and section 21 allow.';

comment on column public.email_settings.encryption_key_version is
  'Which rotation of the encryption master key sealed the credential.';

comment on column public.email_settings.from_address is
  'The sender address every activity email of section 23 leaves from.';

comment on column public.email_settings.from_name is
  'The display name beside that address.';

comment on column public.email_settings.reply_to is
  'The address a reply goes to, null when the sender address takes replies.';

comment on column public.email_settings.status is
  'draft, active or disabled. The partial unique index allows one active row.';

comment on column public.email_settings.activated_at is
  'When the row became active. Required by that state and cleared when it is disabled.';

comment on column public.email_settings.disabled_at is
  'When the row was disabled. Required by that state.';

comment on column public.email_settings.last_tested_at is
  'When the last test email was sent, which an active row must have.';

comment on column public.email_settings.last_test_ok is
  'Whether that test email arrived, which an active row must have true.';

comment on column public.email_settings.last_test_detail is
  'The provider answer of that test, 1 to 280 characters, for the settings screen.';

comment on column public.email_settings.created_by is
  'The super_admin who wrote the configuration.';

comment on column public.email_settings.created_at is
  'When the row was written.';

comment on column public.email_settings.updated_at is
  'Set by the email_settings_set_row_metadata trigger on every update.';

comment on column public.email_settings.deleted_at is
  'Soft delete marker. The guard refuses to set it while the row is active.';

comment on column public.email_settings.version is
  'Optimistic locking counter, incremented by the email_settings_set_row_metadata trigger.';

-- One active sending method, which is the rule section 23 states, as a database invariant.
create unique index email_settings_active_key
  on public.email_settings (status)
  where status = 'active';

-- The settings screen lists the configurations newest first, including the disabled ones.
create index email_settings_status_idx
  on public.email_settings (status, created_at desc)
  where deleted_at is null;

create trigger email_settings_guard_state
  before insert or update on public.email_settings
  for each row
  execute function public.email_settings_guard_state();

create trigger email_settings_set_row_metadata
  before update on public.email_settings
  for each row
  execute function public.set_row_metadata();

alter table public.email_settings enable row level security;

create policy email_settings_default_deny
  on public.email_settings
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
