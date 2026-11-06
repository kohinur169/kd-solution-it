-- path: migrations/0115_invoice_documents.sql
-- STEP 117 - the rendered invoice PDF, as a document of its own rather than a column on the invoice.
--
-- Section 16 asks for "PDF invoice generation" and section 28 says where it must happen: "PDF
-- generation, email, webhook processing and sub-merchant provisioning run as background jobs.
-- Request handlers validate, write minimal rows and enqueue." A job that renders, encrypts and stores
-- a document needs a row to write its state into, because the merchant who asked has to be told
-- something other than "try later": queued, rendering, ready or failed. This table is that row, and
-- the request handler writes exactly one of them and nothing else.
--
-- ## Why not a column on `invoices`
--
-- Three reasons, and the first is `0022`'s own `invoices_guard_paid`: a paid invoice is frozen byte
-- for byte, so a document state that moves from queued to ready after a payment lands could not be
-- written to the invoice row at all. Second, `0022` is the document of record - the money and the
-- printed facts - and a render is an artefact *about* that document, with its own lifecycle, its own
-- failure codes and its own re-render counter. Third, a re-render must not look like an edit: this
-- table's `generation` counts the renders while `invoices.version` keeps counting the edits.
--
-- ## One live row per invoice
--
-- `invoice_documents_one_live_per_invoice` makes the state of an invoice's PDF a single row, so two
-- clicks cannot leave two documents competing to be "the" PDF and a read never has to choose between
-- them. A re-render updates that row in place; the bytes it replaces stay reachable through the `0057`
-- file row, which archives rather than disappears, so the previous PDF of a sent invoice is still
-- evidence.
--
-- ## What the state may say about itself
--
-- `ready` is the only status that carries a file, and it carries all four facts of the render
-- together - file, size, hash and instant - so a screen cannot show a download link with no bytes
-- behind it. `failed` always names an error code from the STEP 008 catalogue, because "it failed"
-- with no reason is what makes a support ticket. The byte ceiling is the `invoice_pdf` policy of
-- `lib/security/upload.ts` (26 214 400), not the whole-file ceiling of `0057`, so a row cannot claim
-- a document the upload layer would have refused.
--
-- `invoice_documents_guard_state` freezes the identity (merchant, invoice, document type), walks the
-- status forward through one render lifecycle, lets the file facts change only at the instant a render
-- completes, never lets `generation` fall, and lets a new request clear the error and the attempt
-- count and nothing else.

begin;

create function public.invoice_documents_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.invoice_id is distinct from old.invoice_id
     or new.document_type is distinct from old.document_type then
    raise exception 'an invoice document keeps its merchant, its invoice and its type'
      using errcode = 'check_violation';
  end if;

  if new.generation < old.generation then
    raise exception 'a render generation never goes backwards'
      using errcode = 'check_violation';
  end if;

  -- The four facts of a completed render move together, and only when the row arrives at `ready`.
  if (new.file_id is distinct from old.file_id
      or new.byte_size is distinct from old.byte_size
      or new.content_sha256 is distinct from old.content_sha256
      or new.rendered_at is distinct from old.rendered_at)
     and not (old.status <> 'ready' and new.status = 'ready') then
    raise exception 'the file facts of an invoice document change only when a render completes'
      using errcode = 'check_violation';
  end if;

  if new.generation > old.generation and new.status <> 'ready' then
    raise exception 'a render generation counts completed renders only'
      using errcode = 'check_violation';
  end if;

  -- A render is dated at or after the request that produced it. This is the guard's to enforce rather
  -- than a column check's: the row keeps the facts of the render it is replacing until the new one
  -- lands, so a re-queued document legitimately carries a `rendered_at` earlier than its `queued_at`.
  if old.status <> 'ready' and new.status = 'ready' and new.rendered_at < new.queued_at then
    raise exception 'a render is dated at or after the request that produced it'
      using errcode = 'check_violation';
  end if;

  if old.status = new.status then
    -- A write that does not move the status may still record an attempt.
    if new.attempts < old.attempts then
      raise exception 'an attempt count never goes backwards'
        using errcode = 'check_violation';
    end if;
  elsif not (
    (old.status = 'queued' and new.status in ('rendering', 'failed'))
    or (old.status = 'rendering' and new.status in ('ready', 'failed'))
    or (old.status = 'failed' and new.status in ('queued', 'rendering'))
    or (old.status = 'ready' and new.status = 'queued')
  ) then
    raise exception 'an invoice document status walks queued, rendering, ready or failed'
      using errcode = 'check_violation';
  end if;

  -- A new request is the only event that forgets an attempt count and a failure reason.
  if new.status = 'queued' and old.status <> 'queued' then
    if new.attempts > 0 then
      raise exception 'a fresh render request starts at zero attempts'
        using errcode = 'check_violation';
    end if;
  elsif new.attempts < old.attempts then
    raise exception 'an attempt count never goes backwards'
      using errcode = 'check_violation';
  elsif old.last_error_code is not null and new.last_error_code is null then
    raise exception 'a failure reason is kept until the next render request'
      using errcode = 'check_violation';
  end if;

  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'a removed invoice document stays removed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.invoice_documents_guard_state() is
  'Freezes the identity of a rendered invoice document and walks its status forward through one render.';

create table public.invoice_documents (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid not null,
  document_type text not null default 'invoice_pdf',
  status text not null default 'queued',
  -- Completed renders. Zero until the first one lands; never reset by a re-render.
  generation integer not null default 0,
  -- Attempts of the current request, so a stalled render is visible without reading the queue.
  attempts integer not null default 0,
  file_id uuid,
  byte_size bigint,
  content_sha256 text,
  rendered_at timestamptz,
  queued_at timestamptz not null default now(),
  last_error_code text,
  -- Provenance only: the audit entry is the authority on who asked. Checked against the merchant by
  -- the same rule `0057` applies to a file uploader.
  requested_by uuid,
  -- The queue record that produced the current state, for a support trace from the row to the job.
  job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_documents_pkey primary key (id),
  constraint invoice_documents_company_fkey foreign key (company_id)
    references public.companies (id),
  -- The composite key of `0022` is what makes a document of another merchant's invoice impossible:
  -- the pair has to exist as a pair in the invoice table, not only as two ids.
  constraint invoice_documents_invoice_fkey foreign key (invoice_id, company_id)
    references public.invoices (id, company_id),
  constraint invoice_documents_file_fkey foreign key (file_id)
    references public.files (id),
  constraint invoice_documents_requested_by_fkey foreign key (requested_by)
    references public.users (id),
  constraint invoice_documents_tenant_key unique (id, company_id),
  constraint invoice_documents_type_check check (document_type = 'invoice_pdf'),
  constraint invoice_documents_status_check check (
    status in ('queued', 'rendering', 'ready', 'failed')
  ),
  constraint invoice_documents_generation_check check (generation between 0 and 1000000),
  constraint invoice_documents_attempts_check check (attempts between 0 and 1000),
  constraint invoice_documents_ready_check check (
    status <> 'ready'
    or (file_id is not null and byte_size is not null
        and content_sha256 is not null and rendered_at is not null)
  ),
  -- The four facts of a render are all present or all absent, so a half written row cannot exist.
  constraint invoice_documents_render_facts_check check (
    (file_id is null) = (rendered_at is null)
    and (file_id is null) = (byte_size is null)
    and (file_id is null) = (content_sha256 is null)
  ),
  constraint invoice_documents_failed_check check (
    status <> 'failed' or last_error_code is not null
  ),
  constraint invoice_documents_error_code_check check (
    last_error_code is null
    or (char_length(last_error_code) between 3 and 40
        and last_error_code ~ '^[A-Z][A-Z0-9_]{2,39}$')
  ),
  -- The `invoice_pdf` upload policy ceiling, not the whole-file one: a row never claims a document
  -- the upload layer would have refused.
  constraint invoice_documents_size_check check (
    byte_size is null or byte_size between 1 and 26214400
  ),
  constraint invoice_documents_hash_check check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint invoice_documents_job_check check (
    job_id is null
    or (char_length(job_id) between 1 and 64 and job_id ~ '^[A-Za-z0-9._:-]+$')
  ),
  constraint invoice_documents_updated_check check (updated_at >= created_at),
  constraint invoice_documents_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  ),
  constraint invoice_documents_row_version_check check (version > 0)
);

comment on table public.invoice_documents is
  'The state of one invoice PDF render per invoice: queued, rendering, ready or failed, and the file it produced.';

comment on column public.invoice_documents.generation is
  'Completed renders. The bytes of an earlier render stay archived in public.files.';

comment on column public.invoice_documents.last_error_code is
  'A code from the STEP 008 catalogue, kept until the merchant asks for another render.';

-- One live document per invoice, which is what makes "the PDF of this invoice" a single row.
create unique index invoice_documents_one_live_per_invoice
  on public.invoice_documents (invoice_id)
  where deleted_at is null;

-- The screen reads by merchant and invoice; the worker sweeps by status.
create index invoice_documents_company_idx
  on public.invoice_documents (company_id, updated_at desc)
  where deleted_at is null;

create index invoice_documents_status_idx
  on public.invoice_documents (status, queued_at)
  where deleted_at is null;

create trigger invoice_documents_guard_state
  before update on public.invoice_documents
  for each row
  execute function public.invoice_documents_guard_state();

create trigger invoice_documents_set_row_metadata
  before update on public.invoice_documents
  for each row
  execute function public.set_row_metadata();

alter table public.invoice_documents enable row level security;

create policy invoice_documents_default_deny
  on public.invoice_documents
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
