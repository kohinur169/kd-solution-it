-- path: migrations/0057_files.sql
-- STEP 031 - the files of section 21: one row for one stored object.
--
-- Section 21 puts the bytes in object storage and the facts about them in the database: "Every
-- file record stores storage_provider, hash, size, type and company." This table is that record.
-- It keeps the provider, the bucket and the key rather than a URL, because a signed URL expires
-- and a stored one would rot; the adapter STEPs of 100-105 read these three and sign a fresh
-- link. The ciphertext never reaches the database, because section 21 encrypts every file before
-- upload, so `ciphertext_iv`, `ciphertext_tag` and `encryption_key_version` are the same quartet
-- `provider_keys` and `payout_bank_accounts` already carry.
--
-- The tenant separation section 30 asks for is a check rather than a habit: `storage_key` must
-- start with the merchant's own id and a slash, so even a buggy service cannot file one
-- merchant's bytes under another merchant's prefix. The key may not contain a parent segment,
-- because a key that climbs out of its prefix would defeat the same rule.
--
-- Magic byte verification from section 21 is a state with evidence. A row starts `pending`, with
-- no verdict; it becomes `ready` once the adapter has read the bytes and the type matches; and it
-- ends `quarantined` with the reason a person needs, or `archived` when the file is retired. A
-- quarantined file that is archived keeps its reason, which is the history of why it never reached
-- a person. The verified pair is `magic_byte_verified` and `verified_at`, and a check refuses
-- `ready` or `archived` without them, while a `pending` row may not carry them.
--
-- `files_guard_state` freezes the identity of the bytes - merchant, uploader, purpose, provider,
-- bucket, key, type, size, hash and the encryption quartet - and walks the status forward only;
-- on insert it also refuses an uploader of another merchant, which `users` forces because it has
-- no `(id, company_id)` key a composite foreign key could point at.
--
-- A removed file is a row with `deleted_at`, set once and never cleared: section 13 keeps records
-- for seven years, and the retention job of STEP 244-250 removes the object and the row. The
-- unique key index is whole rather than partial, so a soft-deleted row still owns its storage key
-- and a re-upload cannot create a second record of the same object.

begin;

create function public.files_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.uploaded_by is not null then
      perform 1 from public.users
      where id = new.uploaded_by and company_id = new.company_id;

      if not found then
        raise exception 'a file uploader belongs to the merchant of the file'
          using errcode = 'check_violation';
      end if;
    end if;

    return new;
  end if;

  if new.company_id is distinct from old.company_id
     or new.uploaded_by is distinct from old.uploaded_by
     or new.purpose is distinct from old.purpose
     or new.storage_provider is distinct from old.storage_provider
     or new.storage_bucket is distinct from old.storage_bucket
     or new.storage_key is distinct from old.storage_key
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.content_sha256 is distinct from old.content_sha256
     or new.encryption_algorithm is distinct from old.encryption_algorithm
     or new.encryption_key_version is distinct from old.encryption_key_version
     or new.ciphertext_iv is distinct from old.ciphertext_iv
     or new.ciphertext_tag is distinct from old.ciphertext_tag then
    raise exception 'a file keeps its merchant, its key and its bytes'
      using errcode = 'check_violation';
  end if;

  if old.magic_byte_verified
     and new.magic_byte_verified is distinct from old.magic_byte_verified then
    raise exception 'a magic byte verdict is recorded once and never cleared'
      using errcode = 'check_violation';
  end if;

  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception 'a file verification instant is recorded once'
      using errcode = 'check_violation';
  end if;

  if old.status is distinct from new.status and not (
    (old.status = 'pending' and new.status in ('ready', 'quarantined'))
    or (old.status = 'ready' and new.status in ('quarantined', 'archived'))
    or (old.status = 'quarantined' and new.status = 'archived' and old.magic_byte_verified)
  ) then
    raise exception 'a file status walks forward from pending to ready, quarantine or archive'
      using errcode = 'check_violation';
  end if;

  if old.quarantined_reason is not null
     and new.quarantined_reason is distinct from old.quarantined_reason then
    raise exception 'a quarantine reason is recorded once and never rewritten'
      using errcode = 'check_violation';
  end if;

  if old.deleted_at is not null then
    raise exception 'a deleted file is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.files_guard_state() is
  'Refuses a foreign uploader on insert, freezes the bytes of a file and walks its status forward.';

create table public.files (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  uploaded_by uuid,
  purpose text not null,
  storage_provider text not null,
  storage_bucket text not null,
  storage_key text not null,
  content_type text not null,
  byte_size bigint not null,
  content_sha256 text not null,
  encryption_algorithm text not null default 'aes-256-gcm',
  encryption_key_version integer not null,
  ciphertext_iv text not null,
  ciphertext_tag text not null,
  magic_byte_verified boolean not null default false,
  verified_at timestamptz,
  status text not null default 'pending',
  quarantined_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint files_pkey primary key (id),
  constraint files_company_fkey foreign key (company_id) references public.companies (id),
  constraint files_uploaded_by_fkey foreign key (uploaded_by) references public.users (id),
  constraint files_purpose_check check (
    purpose in ('kyc_document', 'company_logo', 'invoice_pdf', 'dispute_document',
                'support_attachment')
  ),
  constraint files_provider_check check (storage_provider in ('supabase', 's3')),
  constraint files_bucket_check check (
    char_length(storage_bucket) between 3 and 63
    and storage_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
  ),
  constraint files_key_check check (
    char_length(storage_key) between 3 and 512
    and storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    and position('..' in storage_key) = 0
  ),
  constraint files_tenant_path_check check (storage_key like company_id::text || '/%'),
  constraint files_content_type_check check (content_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  constraint files_size_check check (byte_size between 1 and 52428800),
  constraint files_hash_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint files_algorithm_check check (encryption_algorithm = 'aes-256-gcm'),
  constraint files_key_version_check check (encryption_key_version between 1 and 999),
  constraint files_iv_check check (char_length(ciphertext_iv) between 12 and 64),
  constraint files_tag_check check (char_length(ciphertext_tag) between 16 and 64),
  constraint files_status_check check (
    status in ('pending', 'ready', 'quarantined', 'archived')
  ),
  constraint files_pending_check check (
    status <> 'pending' or (magic_byte_verified = false and verified_at is null)
  ),
  constraint files_verified_check check (
    status not in ('ready', 'archived') or (magic_byte_verified and verified_at is not null)
  ),
  constraint files_quarantine_required_check check (
    status <> 'quarantined' or quarantined_reason is not null
  ),
  constraint files_quarantine_scope_check check (
    quarantined_reason is null or status in ('quarantined', 'archived')
  ),
  constraint files_quarantine_reason_check check (
    quarantined_reason is null
    or (
      char_length(quarantined_reason) between 1 and 280
      and quarantined_reason = btrim(quarantined_reason)
    )
  ),
  constraint files_verified_instant_check check (
    verified_at is null or verified_at >= created_at
  ),
  constraint files_updated_check check (updated_at >= created_at),
  constraint files_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint files_row_version_check check (version > 0)
);

comment on table public.files is
  'One stored object: where its bytes live, what they hash to, and how the upload was verified.';

comment on column public.files.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.files.company_id is
  'The merchant that owns the object. The storage key must start with this id and a slash.';

comment on column public.files.uploaded_by is
  'The person who uploaded the file, null for a file the platform generated itself.';

comment on column public.files.purpose is
  'The upload kind of section 21, from the five names the purpose check enforces.';

comment on column public.files.storage_provider is
  'supabase or s3, the adapter of section 21 that holds the object.';

comment on column public.files.storage_bucket is
  'The bucket the adapter signs in, so one platform can serve several environments.';

comment on column public.files.storage_key is
  'The object key inside the bucket, always under the merchant prefix.';

comment on column public.files.content_type is
  'The mime type the magic byte check agreed with, for example application/pdf.';

comment on column public.files.byte_size is
  'The size of the plaintext in bytes, bounded at the same 50 MB the KYC documents allow.';

comment on column public.files.content_sha256 is
  'SHA-256 of the plaintext bytes, so a restore can prove the object matches this row.';

comment on column public.files.encryption_algorithm is
  'Fixed to aes-256-gcm, the only cipher section 21 allows.';

comment on column public.files.encryption_key_version is
  'Which rotation of the encryption master key sealed the object.';

comment on column public.files.ciphertext_iv is
  'The AES-GCM initialisation vector, 12 to 64 characters of the base64 the adapter wrote.';

comment on column public.files.ciphertext_tag is
  'The AES-GCM authentication tag, 16 to 64 characters, checked before a byte is decrypted.';

comment on column public.files.magic_byte_verified is
  'True once the adapter read the bytes and they matched the declared type. Never cleared.';

comment on column public.files.verified_at is
  'The instant of that verdict. Required by the ready and archived states, written once.';

comment on column public.files.status is
  'pending, ready, quarantined or archived. The guard walks it forward and never back.';

comment on column public.files.quarantined_reason is
  'Why a file was quarantined: required by that state, kept as history when the file is archived.';

comment on column public.files.created_at is
  'When the row was written, which is the instant the adapter finished the upload.';

comment on column public.files.updated_at is
  'Set by the files_set_row_metadata trigger on every update.';

comment on column public.files.deleted_at is
  'Soft delete marker, set once and never cleared; the retention job removes the object later.';

comment on column public.files.version is
  'Optimistic locking counter, incremented by the files_set_row_metadata trigger.';

-- One object is one row: the key is unique forever, so a re-upload cannot fork the record of the
-- same bytes even after a soft delete.
create unique index files_storage_key
  on public.files (storage_provider, storage_bucket, storage_key);

-- The merchant library: every live file of one account, newest first.
create index files_company_page_idx
  on public.files (company_id, created_at desc)
  where deleted_at is null;

-- One purpose of one merchant, which is the logo strip and the invoice attachment list.
create index files_purpose_idx
  on public.files (company_id, purpose, created_at desc)
  where deleted_at is null;

-- The sweep that finishes a verification or archives a quarantine.
create index files_verification_idx
  on public.files (status, created_at)
  where deleted_at is null;

create trigger files_guard_state
  before insert or update on public.files
  for each row
  execute function public.files_guard_state();

create trigger files_set_row_metadata
  before update on public.files
  for each row
  execute function public.set_row_metadata();

alter table public.files enable row level security;

create policy files_default_deny
  on public.files
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
