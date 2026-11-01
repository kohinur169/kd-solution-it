-- path: migrations/0035_store_connections.sql
-- STEP 023 - the Shopify and WooCommerce connections of section 20.
--
-- "Shopify: the platform has its own Shopify app with approval. A merchant installs the app and logs
-- in with credentials, and the connection becomes active and fully functional automatically."
-- WooCommerce works the same way through the platform plugin. The row therefore records the store,
-- the access token the platform will call the store with, and the state of the handshake.
--
-- One store is one row. `(company_id, platform, store_domain)` is unique among the live rows, so a
-- merchant cannot connect the same shop twice and a reinstall reuses the row instead of piling up
-- duplicates. `store_domain` is lower case and bare - no scheme, no trailing slash - because the
-- adapter builds a URL from it and a slash there is a call to another path.
--
-- The access token is a secret the platform must read back on every call, so it is stored as
-- AES-256-GCM ciphertext with its last four characters beside it, exactly as a provider key and a
-- signing secret are. `active` requires `connected_at`, which is the sentence "the connection
-- becomes active automatically" in the only place a check can hold it.
--
-- Once revoked a connection stays revoked: the guard refuses a return to active and refuses a
-- rewritten domain, so a merchant that revokes access must install again rather than be reactivated
-- by a later writer. `error` carries the reason and self clears, because a retry of the handshake is
-- normal in an install flow.

begin;

create function public.store_connections_guard_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.platform is distinct from old.platform
     or new.store_domain is distinct from old.store_domain then
    raise exception 'a store connection keeps its store'
      using errcode = 'check_violation';
  end if;

  if (new.access_token_ciphertext is distinct from old.access_token_ciphertext
      or new.access_token_iv is distinct from old.access_token_iv
      or new.access_token_tag is distinct from old.access_token_tag)
     and new.encryption_key_version <= old.encryption_key_version then
    raise exception 'a store token is re-encrypted only under a new key version'
      using errcode = 'check_violation';
  end if;

  if old.status = 'revoked' and new.status is distinct from old.status then
    raise exception 'a revoked store connection stays revoked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.store_connections_guard_identity() is
  'Freezes the store and its token, and refuses a revoked connection that comes back.';

create table public.store_connections (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  platform text not null,
  store_domain text not null,
  external_store_id text,
  access_token_last_four text not null,
  access_token_ciphertext text not null,
  access_token_iv text not null,
  access_token_tag text not null,
  encryption_key_version integer not null default 1,
  status text not null default 'pending',
  connected_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint store_connections_pkey primary key (id),
  constraint store_connections_company_fkey foreign key (company_id) references public.companies (id),
  constraint store_connections_platform_check check (platform in ('shopify', 'woocommerce')),
  constraint store_connections_domain_check check (
    char_length(store_domain) between 3 and 253
    and store_domain = lower(store_domain)
    and store_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  constraint store_connections_external_id_check check (
    external_store_id is null
    or (
      char_length(external_store_id) between 1 and 120
      and external_store_id = btrim(external_store_id)
    )
  ),
  constraint store_connections_last_four_check check (
    access_token_last_four ~ '^[A-Za-z0-9]{4}$'
  ),
  constraint store_connections_ciphertext_check check (
    char_length(access_token_ciphertext) between 16 and 8192
  ),
  constraint store_connections_iv_check check (char_length(access_token_iv) between 12 and 64),
  constraint store_connections_tag_check check (char_length(access_token_tag) between 16 and 64),
  constraint store_connections_version_check check (encryption_key_version between 1 and 999),
  constraint store_connections_status_check check (
    status in ('pending', 'active', 'revoked', 'error')
  ),
  constraint store_connections_active_check check (
    status <> 'active' or connected_at is not null
  ),
  constraint store_connections_pending_check check (
    status <> 'pending' or connected_at is null
  ),
  constraint store_connections_revoked_check check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  constraint store_connections_error_check check (
    (status = 'error'
      and last_error is not null
      and char_length(last_error) between 1 and 280
      and last_error = btrim(last_error))
    or (status <> 'error' and last_error is null)
  ),
  constraint store_connections_row_version_check check (version > 0),
  constraint store_connections_updated_check check (updated_at >= created_at),
  constraint store_connections_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.store_connections is
  'A Shopify or WooCommerce store the merchant connected, with its encrypted access token.';

comment on column public.store_connections.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.store_connections.company_id is
  'The merchant that installed the app or entered the plugin credentials.';

comment on column public.store_connections.platform is
  'shopify or woocommerce, the two section 20 integrations shipped at launch.';

comment on column public.store_connections.store_domain is
  'The bare lower case shop domain, unique per merchant and platform among live rows.';

comment on column public.store_connections.external_store_id is
  'The identifier the platform gave the store, null until the handshake returns one.';

comment on column public.store_connections.access_token_last_four is
  'The only characters of the store token a screen may show.';

comment on column public.store_connections.access_token_ciphertext is
  'AES-256-GCM ciphertext of the store access token.';

comment on column public.store_connections.access_token_iv is
  'Initialisation vector of that ciphertext.';

comment on column public.store_connections.access_token_tag is
  'Authentication tag of that ciphertext.';

comment on column public.store_connections.encryption_key_version is
  'Which environment encryption key protects the store token.';

comment on column public.store_connections.status is
  'pending during the install, active when the store answers, error on a failure, revoked by the merchant.';

comment on column public.store_connections.connected_at is
  'When the store answered the handshake. Required while active and cleared when pending.';

comment on column public.store_connections.revoked_at is
  'Set exactly when the status is revoked, after which the row cannot come back.';

comment on column public.store_connections.last_error is
  'The failure detail, at most 280 characters, present exactly on an error row.';

comment on column public.store_connections.last_synced_at is
  'When the store last answered a synchronisation call.';

comment on column public.store_connections.created_at is
  'When the connection row was written.';

comment on column public.store_connections.updated_at is
  'Set by the store_connections_set_row_metadata trigger on every update.';

comment on column public.store_connections.deleted_at is
  'Soft delete marker. A removed connection stays readable for the orders it carried.';

comment on column public.store_connections.version is
  'Optimistic locking counter. Incremented by the store_connections_set_row_metadata trigger.';

-- One live connection per store. Reinstalling reuses or replaces the row, it never duplicates it.
create unique index store_connections_domain_key
  on public.store_connections (company_id, platform, store_domain)
  where deleted_at is null;

-- The merchant settings screen.
create index store_connections_company_idx
  on public.store_connections (company_id, platform, status)
  where deleted_at is null;

create trigger store_connections_guard_identity
  before update on public.store_connections
  for each row
  execute function public.store_connections_guard_identity();

create trigger store_connections_set_row_metadata
  before update on public.store_connections
  for each row
  execute function public.set_row_metadata();

alter table public.store_connections enable row level security;

create policy store_connections_default_deny
  on public.store_connections
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
