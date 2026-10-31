-- path: migrations/0036_taxcloud_connections.sql
-- STEP 023 - the TaxCloud connection of section 7.
--
-- "Every merchant can connect a personal TaxCloud account." "TaxCloud credentials are encrypted and
-- only shown masked." "Sales Tax Collection is an on and off option. When enabled, sales tax is
-- collected automatically on invoices." "Collection applies to United States transactions."
--
-- The credentials are an API id and an API key, and both are secrets: each is stored as AES-256-GCM
-- ciphertext with its own last four characters, so the settings screen can show which account is
-- connected without ever showing the account. The tax engine itself and the invoice tax line are not
-- this STEP; the invoice already carries `tax_minor`, and the collector writes it.
--
-- One merchant, one usable connection. The unique index on `company_id` covers every row that is not
-- disabled, so two rows cannot answer the same tax question at once, while a merchant that moves to
-- another account disables the old connection and connects the new one: the disabled row stays
-- readable for the invoices it taxed, and the slot beside it is free.
--
-- `collection_enabled` cannot be true unless the connection is `active`, so tax can never be
-- collected through credentials that were never verified; and `active` requires `verified_at`, so a
-- connection that has not answered is not a connection the invoice writer may use.

begin;

create function public.taxcloud_connections_guard_credentials()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'a tax connection keeps its merchant'
      using errcode = 'check_violation';
  end if;

  if (new.api_id_ciphertext is distinct from old.api_id_ciphertext
      or new.api_id_iv is distinct from old.api_id_iv
      or new.api_id_tag is distinct from old.api_id_tag
      or new.api_key_ciphertext is distinct from old.api_key_ciphertext
      or new.api_key_iv is distinct from old.api_key_iv
      or new.api_key_tag is distinct from old.api_key_tag)
     and new.encryption_key_version <= old.encryption_key_version then
    raise exception 'tax credentials are re-encrypted only under a new key version'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.taxcloud_connections_guard_credentials() is
  'Freezes the merchant of a tax connection and allows new ciphertext only under a higher key version.';

create table public.taxcloud_connections (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  api_id_last_four text not null,
  api_id_ciphertext text not null,
  api_id_iv text not null,
  api_id_tag text not null,
  api_key_last_four text not null,
  api_key_ciphertext text not null,
  api_key_iv text not null,
  api_key_tag text not null,
  encryption_key_version integer not null default 1,
  status text not null default 'pending',
  collection_enabled boolean not null default false,
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint taxcloud_connections_pkey primary key (id),
  constraint taxcloud_connections_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint taxcloud_connections_api_id_last_four_check check (
    api_id_last_four ~ '^[A-Za-z0-9]{4}$'
  ),
  constraint taxcloud_connections_api_id_ciphertext_check check (
    char_length(api_id_ciphertext) between 16 and 8192
  ),
  constraint taxcloud_connections_api_id_iv_check check (char_length(api_id_iv) between 12 and 64),
  constraint taxcloud_connections_api_id_tag_check check (char_length(api_id_tag) between 16 and 64),
  constraint taxcloud_connections_api_key_last_four_check check (
    api_key_last_four ~ '^[A-Za-z0-9]{4}$'
  ),
  constraint taxcloud_connections_api_key_ciphertext_check check (
    char_length(api_key_ciphertext) between 16 and 8192
  ),
  constraint taxcloud_connections_api_key_iv_check check (char_length(api_key_iv) between 12 and 64),
  constraint taxcloud_connections_api_key_tag_check check (char_length(api_key_tag) between 16 and 64),
  constraint taxcloud_connections_version_check check (encryption_key_version between 1 and 999),
  constraint taxcloud_connections_status_check check (status in ('pending', 'active', 'disabled')),
  constraint taxcloud_connections_verified_check check (
    (status = 'active') = (verified_at is not null)
  ),
  constraint taxcloud_connections_collection_check check (
    collection_enabled = false or status = 'active'
  ),
  constraint taxcloud_connections_error_check check (
    last_error is null
    or (
      char_length(last_error) between 1 and 280
      and last_error = btrim(last_error)
    )
  ),
  constraint taxcloud_connections_row_version_check check (version > 0),
  constraint taxcloud_connections_updated_check check (updated_at >= created_at),
  constraint taxcloud_connections_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.taxcloud_connections is
  'A merchant TaxCloud account: both credentials encrypted, one connection per merchant.';

comment on column public.taxcloud_connections.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.taxcloud_connections.company_id is
  'The merchant that owns the account. At most one connection per merchant that is not disabled.';

comment on column public.taxcloud_connections.api_id_last_four is
  'The only characters of the TaxCloud API id a screen may show.';

comment on column public.taxcloud_connections.api_id_ciphertext is
  'AES-256-GCM ciphertext of the TaxCloud API id.';

comment on column public.taxcloud_connections.api_id_iv is
  'Initialisation vector of that ciphertext.';

comment on column public.taxcloud_connections.api_id_tag is
  'Authentication tag of that ciphertext.';

comment on column public.taxcloud_connections.api_key_last_four is
  'The only characters of the TaxCloud API key a screen may show.';

comment on column public.taxcloud_connections.api_key_ciphertext is
  'AES-256-GCM ciphertext of the TaxCloud API key.';

comment on column public.taxcloud_connections.api_key_iv is
  'Initialisation vector of that ciphertext.';

comment on column public.taxcloud_connections.api_key_tag is
  'Authentication tag of that ciphertext.';

comment on column public.taxcloud_connections.encryption_key_version is
  'Which environment encryption key protects both credentials.';

comment on column public.taxcloud_connections.status is
  'pending before the first verification, active once TaxCloud answers, disabled by the merchant.';

comment on column public.taxcloud_connections.collection_enabled is
  'The section 7 on and off switch. It cannot be on unless the connection is active.';

comment on column public.taxcloud_connections.verified_at is
  'Set exactly when the status is active, which is the instant TaxCloud last answered a verification.';

comment on column public.taxcloud_connections.last_error is
  'The last failure detail, at most 280 characters.';

comment on column public.taxcloud_connections.created_at is
  'When the account was entered.';

comment on column public.taxcloud_connections.updated_at is
  'Set by the taxcloud_connections_set_row_metadata trigger on every update.';

comment on column public.taxcloud_connections.deleted_at is
  'Soft delete marker. A removed connection stays readable for the invoices it taxed.';

comment on column public.taxcloud_connections.version is
  'Optimistic locking counter. Incremented by the taxcloud_connections_set_row_metadata trigger.';

-- One usable connection per merchant: a disabled row is history and does not hold the slot.
create unique index taxcloud_connections_company_key
  on public.taxcloud_connections (company_id)
  where deleted_at is null and status <> 'disabled';

create trigger taxcloud_connections_guard_credentials
  before update on public.taxcloud_connections
  for each row
  execute function public.taxcloud_connections_guard_credentials();

create trigger taxcloud_connections_set_row_metadata
  before update on public.taxcloud_connections
  for each row
  execute function public.set_row_metadata();

alter table public.taxcloud_connections enable row level security;

create policy taxcloud_connections_default_deny
  on public.taxcloud_connections
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
