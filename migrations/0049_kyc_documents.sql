-- path: migrations/0049_kyc_documents.sql
-- STEP 028 - the documents a merchant uploads for verification, section 5.
--
-- Section 5 names the uploads: a utility bill issued within three months, a bank statement, a source of
-- funds document, an identity document, the business registration and any extra document a processor
-- asks for. That list is the closed vocabulary of `document_type`, and a utility bill without its issue
-- instant is refused because the three month rule cannot be checked without it.
--
-- A row is evidence, not the file. The bytes live in the storage adapter of sections 100-105, so this
-- table keeps the storage key, the SHA-256 of the content, the mime type and the size, and it never
-- keeps a file, a base64 blob or a path outside the bucket. `kyc_documents_guard_state` freezes the key
-- and the hash of the bytes, so an accepted document cannot be swapped for another one under the same
-- identity.
--
-- A document is `uploaded`, then `accepted` or `rejected` by a person with an instant, and a rejection
-- carries its reason for the merchant. The submission it belongs to is a composite foreign key, so a
-- document cannot be filed under another merchant's submission.

begin;

create function public.kyc_documents_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.submission_id is distinct from old.submission_id
     or new.document_type is distinct from old.document_type
     or new.storage_key is distinct from old.storage_key
     or new.content_sha256 is distinct from old.content_sha256
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.issued_at is distinct from old.issued_at then
    raise exception 'a KYC document keeps its submission, its type and its bytes'
      using errcode = 'check_violation';
  end if;

  if old.status in ('accepted', 'rejected')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a reviewed KYC document is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.kyc_documents_guard_state() is
  'Freezes the submission, the type and the bytes of a document and locks a reviewed one.';

create table public.kyc_documents (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  submission_id uuid not null,
  document_type text not null,
  storage_key text not null,
  content_sha256 text not null,
  content_type text not null,
  byte_size bigint not null,
  issued_at timestamptz,
  expires_at timestamptz,
  status text not null default 'uploaded',
  reviewed_at timestamptz,
  reviewed_by uuid,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint kyc_documents_pkey primary key (id),
  constraint kyc_documents_company_fkey foreign key (company_id) references public.companies (id),
  constraint kyc_documents_submission_fkey foreign key (submission_id, company_id)
    references public.kyc_submissions (id, company_id),
  constraint kyc_documents_reviewed_by_fkey foreign key (reviewed_by) references public.users (id),
  constraint kyc_documents_type_check check (
    document_type in ('utility_bill', 'bank_statement', 'source_of_funds', 'identity_document',
                      'business_registration', 'processor_request')
  ),
  constraint kyc_documents_status_check check (status in ('uploaded', 'accepted', 'rejected')),
  constraint kyc_documents_key_check check (
    char_length(storage_key) between 1 and 512
    and storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  ),
  constraint kyc_documents_hash_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint kyc_documents_content_type_check check (
    content_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'
  ),
  constraint kyc_documents_size_check check (byte_size between 1 and 52428800),
  constraint kyc_documents_issue_check check (
    document_type <> 'utility_bill' or issued_at is not null
  ),
  constraint kyc_documents_validity_check check (
    expires_at is null or (issued_at is not null and expires_at > issued_at)
  ),
  constraint kyc_documents_reviewed_check check (
    (status <> 'uploaded') = (reviewed_at is not null)
    and (status <> 'uploaded') = (reviewed_by is not null)
  ),
  constraint kyc_documents_rejection_check check (
    (status = 'rejected') = (rejection_reason is not null)
    and (
      rejection_reason is null
      or (
        char_length(rejection_reason) between 1 and 280
        and rejection_reason = btrim(rejection_reason)
      )
    )
  ),
  constraint kyc_documents_order_check check (
    (issued_at is null or issued_at <= created_at)
    and (reviewed_at is null or reviewed_at >= created_at)
  ),
  constraint kyc_documents_row_version_check check (version > 0),
  constraint kyc_documents_updated_check check (updated_at >= created_at),
  constraint kyc_documents_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.kyc_documents is
  'One uploaded document of a KYC submission, kept as a key and a hash rather than as a file.';

comment on column public.kyc_documents.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.kyc_documents.company_id is
  'The merchant that uploaded the document. Frozen after the row is written.';

comment on column public.kyc_documents.submission_id is
  'The submission the document belongs to, through the composite key of its merchant.';

comment on column public.kyc_documents.document_type is
  'utility_bill, bank_statement, source_of_funds, identity_document, business_registration or '
  'processor_request.';

comment on column public.kyc_documents.storage_key is
  'The key inside the storage bucket. The file itself is never a column here.';

comment on column public.kyc_documents.content_sha256 is
  'SHA-256 of the bytes, 64 lower case hex, so a swapped file is detectable.';

comment on column public.kyc_documents.content_type is
  'The mime type of the file, such as application/pdf.';

comment on column public.kyc_documents.byte_size is
  'The size in bytes, from 1 to 50 megabytes.';

comment on column public.kyc_documents.issued_at is
  'When the document was issued, required for a utility bill and its three month rule.';

comment on column public.kyc_documents.expires_at is
  'When the document stops being valid, when it has such a date.';

comment on column public.kyc_documents.status is
  'uploaded, accepted or rejected. The last two lock the row.';

comment on column public.kyc_documents.reviewed_at is
  'Set exactly when a person reviewed the document.';

comment on column public.kyc_documents.reviewed_by is
  'The person who reviewed the document, required with the instant.';

comment on column public.kyc_documents.rejection_reason is
  'Why the document was rejected, at most 280 characters and trimmed.';

comment on column public.kyc_documents.created_at is
  'When the row was written.';

comment on column public.kyc_documents.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.kyc_documents.deleted_at is
  'Soft delete marker, refused once the document is reviewed.';

comment on column public.kyc_documents.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- Every document of one submission, newest first.
create index kyc_documents_submission_idx
  on public.kyc_documents (submission_id, created_at desc)
  where deleted_at is null;

-- What still needs a person: uploaded and not yet reviewed.
create index kyc_documents_review_idx
  on public.kyc_documents (company_id, created_at)
  where status = 'uploaded' and deleted_at is null;

-- The bytes of one document are found by their hash.
create index kyc_documents_hash_idx
  on public.kyc_documents (content_sha256);

create trigger kyc_documents_guard_state
  before update on public.kyc_documents
  for each row
  execute function public.kyc_documents_guard_state();

create trigger kyc_documents_set_row_metadata
  before update on public.kyc_documents
  for each row
  execute function public.set_row_metadata();

alter table public.kyc_documents enable row level security;

create policy kyc_documents_default_deny
  on public.kyc_documents
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
