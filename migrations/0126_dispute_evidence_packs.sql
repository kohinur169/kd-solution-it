-- path: migrations/0126_dispute_evidence_packs.sql
-- STEP 197 - the structured chargeback evidence pack of section 19.
--
-- Section 19 names its four parts in one sentence: "A structured chargeback evidence pack is assembled:
-- invoice, delivery proof, client communication record and terms acceptance record." Section 19 also gives
-- the merchant the documents: "The dispute interface: list, status and document upload", and "the merchant
-- writes the dispute response and supplies the required documents". This file carries the two tables those
-- sentences need, and the one word `0039` already reserved for them:
--
--   1. `dispute_evidence_packs` - one pack per dispute, a draft while it is being built and frozen once it
--      is complete. `0039`'s `evidence_ready` is the flag a submission requires, and from here on the only
--      way to raise it is to freeze a pack, which the trigger on `disputes` enforces.
--   2. `dispute_evidence_items` - the structured records the platform already holds, copied into the pack:
--      the invoice, the fulfilment evidence, the client correspondence, the acceptance records. A copy, not
--      a view: a pack is a snapshot of what the merchant stood behind at the moment it was frozen.
--   3. `dispute_evidence_documents` - the files the merchant uploads, each filed under one of the four
--      sections, with the digest and the storage key and never the bytes.
--
-- ## Why a snapshot rather than four joins at submission time
--
-- A chargeback is decided weeks after it is opened, and the processor's reviewer reads the pack, not the
-- platform. If the pack were a query, then a corrected invoice, a re-recorded delivery or a deleted support
-- ticket would silently rewrite evidence that has already been sent. So each item carries its own copy of the
-- label and the summary and the instant it was captured, the pack carries the SHA-256 of the whole set, and
-- `dispute_evidence_items_guard` refuses every change once the pack is frozen.
--
-- ## The gates
--
--   * `dispute_evidence_packs_guard` - a pack keeps its dispute and its building merchant; a frozen pack is
--     immovable; the draft to frozen transition is the one place completeness is decided, and it decides it
--     against the rows rather than against a number the caller sent. The item and document counts are written
--     by that trigger, so a screen cannot claim a pack is complete.
--   * `dispute_evidence_items_guard` / `dispute_evidence_documents_guard` - nothing is added to, removed from
--     or rewritten in a frozen pack; a row cannot move between packs or sections; a merchant's pack cannot
--     hold another merchant's record.
--   * `disputes_guard_evidence` - `evidence_ready` is true only while a frozen pack exists for that dispute
--     and that merchant, and a dispute whose pack is frozen cannot be un-readied. `0039` said the flag means
--     "the pack of section 19 has been assembled"; this trigger is what makes that true rather than asserted.
--
-- ## What is deliberately absent
--
-- No amount, no currency and no payment reference: the money is in `0037` and the dispute is in `0039`, and a
-- third copy here would be a third answer. No file bytes and no encryption quartet: a document row is a
-- `files`-shaped reference (key, digest, size, type) pointing at the `0057` row that holds the ciphertext
-- quartet, and the encryption and the storage binding stay the storage STEPs' (100-105), exactly as
-- `lib/storage/kyc.ts` binds them for a KYC document. No address and no
-- message body in an item row: a summary is a bounded sentence the merchant could read out loud, not a copy
-- of a client's correspondence.
--
-- All three tables carry `company_id` and default-deny under row level security with the platform's service
-- role as the only writer, like every other table in the chain.

begin;

create table public.dispute_evidence_packs (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  dispute_id uuid not null,
  status text not null default 'draft',
  digest text,
  item_count integer not null default 0,
  document_count integer not null default 0,
  frozen_at timestamptz,
  built_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint dispute_evidence_packs_pkey primary key (id),
  constraint dispute_evidence_packs_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint dispute_evidence_packs_dispute_fkey foreign key (dispute_id)
    references public.disputes (id),
  constraint dispute_evidence_packs_builder_fkey foreign key (built_by_user_id)
    references public.users (id),
  constraint dispute_evidence_packs_status_check check (status in ('draft', 'frozen')),
  constraint dispute_evidence_packs_digest_check check (
    digest is null or digest ~ '^[0-9a-f]{64}$'
  ),
  constraint dispute_evidence_packs_frozen_check check (
    (status = 'frozen') = (frozen_at is not null and digest is not null)
  ),
  constraint dispute_evidence_packs_counts_check check (item_count >= 0 and document_count >= 0),
  constraint dispute_evidence_packs_frozen_after_creation_check check (
    frozen_at is null or frozen_at >= created_at
  ),
  constraint dispute_evidence_packs_row_version_check check (version > 0),
  constraint dispute_evidence_packs_updated_check check (updated_at >= created_at),
  constraint dispute_evidence_packs_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.dispute_evidence_packs is
  'One structured chargeback evidence pack per dispute, drafted by the merchant and frozen when complete.';

comment on column public.dispute_evidence_packs.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.dispute_evidence_packs.company_id is
  'The merchant. Equal to the dispute tenant, which dispute_evidence_packs_guard re-checks.';

comment on column public.dispute_evidence_packs.dispute_id is
  'The dispute the pack answers. At most one live pack, because a frozen pack is the evidence that was sent.';

comment on column public.dispute_evidence_packs.status is
  'draft while the merchant builds it, frozen once complete. The transition happens once and never reverses.';

comment on column public.dispute_evidence_packs.digest is
  'SHA-256 of the assembled items and documents, hex, written at the freeze. Null while the pack is a draft.';

comment on column public.dispute_evidence_packs.item_count is
  'Live items at the freeze, written by the trigger rather than by the caller.';

comment on column public.dispute_evidence_packs.document_count is
  'Live documents at the freeze, written by the trigger rather than by the caller.';

comment on column public.dispute_evidence_packs.frozen_at is
  'When the pack became evidence. Null while it is a draft, and never cleared.';

comment on column public.dispute_evidence_packs.built_by_user_id is
  'The merchant account that opened the pack. Never moves, and never a system identity.';

comment on column public.dispute_evidence_packs.created_at is
  'When the draft was opened.';

comment on column public.dispute_evidence_packs.updated_at is
  'Set by the dispute_evidence_packs_set_row_metadata trigger on every update.';

comment on column public.dispute_evidence_packs.deleted_at is
  'Soft delete marker, used only for a draft a merchant abandoned. A frozen pack is never removed.';

comment on column public.dispute_evidence_packs.version is
  'Optimistic locking counter. Incremented by the dispute_evidence_packs_set_row_metadata trigger.';

-- One live pack per dispute: a draft is the only thing that can be replaced by another draft, and a frozen
-- pack is the evidence a submission points at.
create unique index dispute_evidence_packs_live_key
  on public.dispute_evidence_packs (dispute_id)
  where deleted_at is null;

create index dispute_evidence_packs_company_idx
  on public.dispute_evidence_packs (company_id, created_at desc)
  where deleted_at is null;

create table public.dispute_evidence_items (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  pack_id uuid not null,
  section text not null,
  source_kind text not null,
  source_id uuid,
  label text not null,
  summary text,
  captured_at timestamptz not null,
  added_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint dispute_evidence_items_pkey primary key (id),
  constraint dispute_evidence_items_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint dispute_evidence_items_pack_fkey foreign key (pack_id)
    references public.dispute_evidence_packs (id),
  constraint dispute_evidence_items_user_fkey foreign key (added_by_user_id)
    references public.users (id),
  constraint dispute_evidence_items_section_check check (
    section in ('invoice', 'delivery', 'communication', 'terms')
  ),
  constraint dispute_evidence_items_source_check check (
    source_kind in ('invoice', 'fulfilment', 'acceptance', 'policy', 'communication', 'event', 'note')
  ),
  constraint dispute_evidence_items_source_id_check check (
    (source_kind = 'note') = (source_id is null)
  ),
  constraint dispute_evidence_items_label_check check (
    char_length(label) between 3 and 120 and label = btrim(label)
  ),
  constraint dispute_evidence_items_summary_check check (
    summary is null or (char_length(summary) between 1 and 600 and summary = btrim(summary))
  ),
  constraint dispute_evidence_items_captured_check check (captured_at <= created_at),
  constraint dispute_evidence_items_row_version_check check (version > 0),
  constraint dispute_evidence_items_updated_check check (updated_at >= created_at),
  constraint dispute_evidence_items_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.dispute_evidence_items is
  'The structured records assembled into a pack: a copy of one invoice fact, delivery fact, message or acceptance.';

comment on column public.dispute_evidence_items.id is
  'UUID v7 primary key.';

comment on column public.dispute_evidence_items.company_id is
  'The merchant. Equal to the pack tenant, which dispute_evidence_items_guard re-checks.';

comment on column public.dispute_evidence_items.pack_id is
  'The pack this record belongs to. Fixed for the life of the row.';

comment on column public.dispute_evidence_items.section is
  'invoice, delivery, communication or terms - the four parts of section 19''s pack.';

comment on column public.dispute_evidence_items.source_kind is
  'Where the record came from: the invoice, the fulfilment evidence, an acceptance, a policy, a message, an event, or a merchant note.';

comment on column public.dispute_evidence_items.source_id is
  'The row the record was copied from. Null only for a merchant note, which has no source.';

comment on column public.dispute_evidence_items.label is
  'The one line the pack prints for this record, 3 to 120 characters, never rewritten after the freeze.';

comment on column public.dispute_evidence_items.summary is
  'Optional sentence describing the record, at most 600 characters, copied at the moment it was added.';

comment on column public.dispute_evidence_items.captured_at is
  'The instant of the source fact - when the invoice was paid, the message sent, the acceptance signed.';

comment on column public.dispute_evidence_items.added_by_user_id is
  'The merchant account that put this record in the pack. Null is impossible: a pack is assembled by a person.';

comment on column public.dispute_evidence_items.created_at is
  'When the record was added to the pack.';

comment on column public.dispute_evidence_items.updated_at is
  'Set by the dispute_evidence_items_set_row_metadata trigger on every update.';

comment on column public.dispute_evidence_items.deleted_at is
  'Soft delete marker, used only while the pack is a draft.';

comment on column public.dispute_evidence_items.version is
  'Optimistic locking counter. Incremented by the dispute_evidence_items_set_row_metadata trigger.';

create unique index dispute_evidence_items_live_key
  on public.dispute_evidence_items (pack_id, section, source_kind, source_id)
  where deleted_at is null;

create index dispute_evidence_items_pack_idx
  on public.dispute_evidence_items (pack_id, section, captured_at desc)
  where deleted_at is null;

create index dispute_evidence_items_company_idx
  on public.dispute_evidence_items (company_id, created_at desc)
  where deleted_at is null;

create table public.dispute_evidence_documents (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  pack_id uuid not null,
  section text not null,
  file_name text not null,
  content_type text not null,
  byte_size bigint not null,
  content_sha256 text not null,
  storage_key text not null,
  file_id uuid not null,
  caption text,
  uploaded_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint dispute_evidence_documents_pkey primary key (id),
  constraint dispute_evidence_documents_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint dispute_evidence_documents_pack_fkey foreign key (pack_id)
    references public.dispute_evidence_packs (id),
  constraint dispute_evidence_documents_user_fkey foreign key (uploaded_by_user_id)
    references public.users (id),
  constraint dispute_evidence_documents_file_fkey foreign key (file_id)
    references public.files (id),
  constraint dispute_evidence_documents_section_check check (
    section in ('invoice', 'delivery', 'communication', 'terms')
  ),
  constraint dispute_evidence_documents_name_check check (
    char_length(file_name) between 3 and 120 and file_name = btrim(file_name)
  ),
  constraint dispute_evidence_documents_type_check check (
    content_type in ('application/pdf', 'image/jpeg', 'image/png')
  ),
  constraint dispute_evidence_documents_size_check check (
    byte_size between 1 and 52428800
  ),
  constraint dispute_evidence_documents_digest_check check (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint dispute_evidence_documents_key_check check (
    storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{7,299}$'
  ),
  constraint dispute_evidence_documents_caption_check check (
    caption is null or (char_length(caption) between 3 and 160 and caption = btrim(caption))
  ),
  constraint dispute_evidence_documents_row_version_check check (version > 0),
  constraint dispute_evidence_documents_updated_check check (updated_at >= created_at),
  constraint dispute_evidence_documents_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.dispute_evidence_documents is
  'The files a merchant supplies for a dispute, filed under one of section 19''s four sections.';

comment on column public.dispute_evidence_documents.id is
  'UUID v7 primary key.';

comment on column public.dispute_evidence_documents.company_id is
  'The merchant. Equal to the pack tenant, which dispute_evidence_documents_guard re-checks.';

comment on column public.dispute_evidence_documents.pack_id is
  'The pack this document belongs to. Fixed for the life of the row.';

comment on column public.dispute_evidence_documents.section is
  'Which of the four sections the document supports.';

comment on column public.dispute_evidence_documents.file_name is
  'The name the merchant uploaded, 3 to 120 characters, printed as it is.';

comment on column public.dispute_evidence_documents.content_type is
  'The type the upload was accepted as: PDF, JPEG or PNG, the three the dispute_document policy allows.';

comment on column public.dispute_evidence_documents.byte_size is
  'The size of the bytes that were stored, at most the 50 MiB the upload policy allows.';

comment on column public.dispute_evidence_documents.content_sha256 is
  'SHA-256 of the stored bytes, hex. Unique per pack, so one file is never attached twice.';

comment on column public.dispute_evidence_documents.storage_key is
  'The object key in the platform bucket, copied from the files row so a pack reads on its own.';

comment on column public.dispute_evidence_documents.file_id is
  'The 0057 files row holding the ciphertext quartet, the digest and the verified status of these bytes.';

comment on column public.dispute_evidence_documents.caption is
  'Optional sentence saying what the document shows, at most 160 characters.';

comment on column public.dispute_evidence_documents.uploaded_by_user_id is
  'The merchant account that supplied the file.';

comment on column public.dispute_evidence_documents.created_at is
  'When the document was attached to the pack.';

comment on column public.dispute_evidence_documents.updated_at is
  'Set by the dispute_evidence_documents_set_row_metadata trigger on every update.';

comment on column public.dispute_evidence_documents.deleted_at is
  'Soft delete marker, used only while the pack is a draft.';

comment on column public.dispute_evidence_documents.version is
  'Optimistic locking counter. Incremented by the dispute_evidence_documents_set_row_metadata trigger.';

create unique index dispute_evidence_documents_pack_key
  on public.dispute_evidence_documents (pack_id, content_sha256)
  where deleted_at is null;

create index dispute_evidence_documents_pack_idx
  on public.dispute_evidence_documents (pack_id, section, created_at desc)
  where deleted_at is null;

create index dispute_evidence_documents_company_idx
  on public.dispute_evidence_documents (company_id, created_at desc)
  where deleted_at is null;

create index dispute_evidence_documents_file_idx
  on public.dispute_evidence_documents (file_id)
  where deleted_at is null;

create function public.dispute_evidence_packs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  covered integer;
  documents integer;
  resolved_at timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'an evidence pack is never removed'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from old.company_id
     or new.dispute_id is distinct from old.dispute_id
     or new.built_by_user_id is distinct from old.built_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'the identity of an evidence pack never moves'
      using errcode = 'check_violation';
  end if;

  if old.status = 'frozen' then
    if new.status is distinct from old.status
       or new.digest is distinct from old.digest
       or new.frozen_at is distinct from old.frozen_at
       or new.item_count is distinct from old.item_count
       or new.document_count is distinct from old.document_count
       or new.deleted_at is distinct from old.deleted_at then
      raise exception 'a frozen evidence pack is evidence and is never rewritten'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  if new.status = 'draft' then
    if old.status = 'draft' and new.deleted_at is not null and old.deleted_at is null then
      if new.digest is not null or new.frozen_at is not null then
        raise exception 'an abandoned draft carries no digest and no freeze'
          using errcode = 'check_violation';
      end if;
    end if;

    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'an abandoned evidence pack cannot be brought back'
        using errcode = 'check_violation';
    end if;

    return new;
  end if;

  -- The freeze: the one transition, decided against the rows rather than against a count the caller sent.
  select disputes.resolved_at
    into resolved_at
    from public.disputes as disputes
   where disputes.id = new.dispute_id
     and disputes.company_id = new.company_id;

  if not found then
    raise exception 'an evidence pack must belong to one of the dispute''s own merchants'
      using errcode = 'check_violation';
  end if;

  if resolved_at is not null then
    raise exception 'a decided dispute needs no evidence pack'
      using errcode = 'check_violation';
  end if;

  select count(*)
    into covered
    from unnest(array['invoice', 'delivery', 'communication', 'terms']::text[]) as required (section)
   where exists (
           select 1
             from public.dispute_evidence_items as items
            where items.pack_id = new.id
              and items.section = required.section
              and items.deleted_at is null
         )
      or exists (
           select 1
             from public.dispute_evidence_documents as documents_row
            where documents_row.pack_id = new.id
              and documents_row.section = required.section
              and documents_row.deleted_at is null
         );

  if covered <> 4 then
    raise exception 'an evidence pack needs the invoice, the delivery proof, the communication record and the terms acceptance before it can be frozen'
      using errcode = 'check_violation';
  end if;

  select count(*)
    into documents
    from public.dispute_evidence_documents as documents_row
   where documents_row.pack_id = new.id
     and documents_row.deleted_at is null;

  if documents = 0 then
    raise exception 'a frozen evidence pack carries at least one supplied document'
      using errcode = 'check_violation';
  end if;

  -- The counts are the trigger's answer, so a screen cannot claim a complete pack: a caller that sent
  -- item_count = 4 into a draft holding nothing still freezes nothing.
  select count(*)
    into new.item_count
    from public.dispute_evidence_items as items
   where items.pack_id = new.id
     and items.deleted_at is null;

  new.document_count := documents;

  if new.digest is null or new.frozen_at is null then
    raise exception 'the freeze carries the digest of what was frozen and the instant it happened'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.dispute_evidence_packs_guard() is
  'Keeps a pack on its dispute, refuses removal and rewrites, and decides completeness at the one freeze.';

create trigger dispute_evidence_packs_guard
  before update or delete on public.dispute_evidence_packs
  for each row
  execute function public.dispute_evidence_packs_guard();

create trigger dispute_evidence_packs_set_row_metadata
  before update on public.dispute_evidence_packs
  for each row
  execute function public.set_row_metadata();

create function public.dispute_evidence_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pack_status text;
  pack_company uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'an evidence record is removed by its deleted_at, never by a delete'
      using errcode = 'check_violation';
  end if;

  select packs.status, packs.company_id
    into pack_status, pack_company
    from public.dispute_evidence_packs as packs
   where packs.id = new.pack_id;

  if not found then
    raise exception 'an evidence record belongs to a pack that exists'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from pack_company then
    raise exception 'an evidence record belongs to the pack''s own merchant'
      using errcode = 'check_violation';
  end if;

  if pack_status <> 'draft' then
    raise exception 'a frozen evidence pack does not change'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then
    if new.pack_id is distinct from old.pack_id
       or new.company_id is distinct from old.company_id
       or new.section is distinct from old.section
       or new.source_kind is distinct from old.source_kind
       or new.source_id is distinct from old.source_id
       or new.added_by_user_id is distinct from old.added_by_user_id
       or new.created_at is distinct from old.created_at then
      raise exception 'the identity of an evidence record never moves'
        using errcode = 'check_violation';
    end if;

    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'a removed evidence record cannot be brought back'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.dispute_evidence_items_guard() is
  'Refuses deletes, tenant and identity changes, and every write to a frozen pack.';

create trigger dispute_evidence_items_guard
  before insert or update or delete on public.dispute_evidence_items
  for each row
  execute function public.dispute_evidence_items_guard();

create trigger dispute_evidence_items_set_row_metadata
  before update on public.dispute_evidence_items
  for each row
  execute function public.set_row_metadata();

create function public.dispute_evidence_documents_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pack_status text;
  pack_company uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'a supplied document is removed by its deleted_at, never by a delete'
      using errcode = 'check_violation';
  end if;

  select packs.status, packs.company_id
    into pack_status, pack_company
    from public.dispute_evidence_packs as packs
   where packs.id = new.pack_id;

  if not found then
    raise exception 'a document belongs to a pack that exists'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from pack_company then
    raise exception 'a document belongs to the pack''s own merchant'
      using errcode = 'check_violation';
  end if;

  if pack_status <> 'draft' then
    raise exception 'a frozen evidence pack does not change'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then
    if new.pack_id is distinct from old.pack_id
       or new.company_id is distinct from old.company_id
       or new.file_name is distinct from old.file_name
       or new.content_type is distinct from old.content_type
       or new.byte_size is distinct from old.byte_size
       or new.content_sha256 is distinct from old.content_sha256
       or new.storage_key is distinct from old.storage_key
       or new.file_id is distinct from old.file_id
       or new.uploaded_by_user_id is distinct from old.uploaded_by_user_id
       or new.created_at is distinct from old.created_at then
      raise exception 'the identity of a supplied document never moves'
        using errcode = 'check_violation';
    end if;

    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'a removed document cannot be brought back'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.dispute_evidence_documents_guard() is
  'Refuses deletes, tenant and identity changes, and every write to a frozen pack.';

create trigger dispute_evidence_documents_guard
  before insert or update or delete on public.dispute_evidence_documents
  for each row
  execute function public.dispute_evidence_documents_guard();

create trigger dispute_evidence_documents_set_row_metadata
  before update on public.dispute_evidence_documents
  for each row
  execute function public.set_row_metadata();

create function public.disputes_guard_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.evidence_ready is not distinct from old.evidence_ready then
    return new;
  end if;

  if new.evidence_ready then
    if new.resolved_at is not null then
      raise exception 'a decided dispute needs no evidence flag'
        using errcode = 'check_violation';
    end if;

    if not exists (
      select 1
        from public.dispute_evidence_packs as packs
       where packs.dispute_id = new.id
         and packs.company_id = new.company_id
         and packs.status = 'frozen'
         and packs.deleted_at is null
    ) then
      raise exception 'a dispute is evidence ready only when its pack is frozen'
        using errcode = 'check_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    if exists (
      select 1
        from public.dispute_evidence_packs as packs
       where packs.dispute_id = old.id
         and packs.status = 'frozen'
         and packs.deleted_at is null
    ) then
      raise exception 'a dispute whose pack is frozen stays evidence ready'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.disputes_guard_evidence() is
  'Makes 0039''s evidence_ready flag mean what its comment says: the section 19 pack exists and is frozen.';

create trigger disputes_guard_evidence
  before insert or update on public.disputes
  for each row
  execute function public.disputes_guard_evidence();

alter table public.dispute_evidence_packs enable row level security;

create policy dispute_evidence_packs_default_deny
  on public.dispute_evidence_packs
  as permissive
  for all
  to public
  using (false)
  with check (false);

alter table public.dispute_evidence_items enable row level security;

create policy dispute_evidence_items_default_deny
  on public.dispute_evidence_items
  as permissive
  for all
  to public
  using (false)
  with check (false);

alter table public.dispute_evidence_documents enable row level security;

create policy dispute_evidence_documents_default_deny
  on public.dispute_evidence_documents
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
