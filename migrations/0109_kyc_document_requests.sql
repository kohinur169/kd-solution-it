-- path: migrations/0109_kyc_document_requests.sql
-- STEP 097 - the extra document a processor asks for, and the merchant's answer to it.
--
-- FEATURE_LIST section 5 line 61 names the uploads: "utility bill issued within 3 months, bank
-- statement, source of funds document, and any extra document a processor requests." `0049` already
-- carries that last kind as the `processor_request` document type; this file stores the REQUEST
-- itself, so the flow from provider to merchant is a row and not a phone call: the processor asks
-- for one more document, the ask is recorded here against the merchant's draft submission, the
-- merchant sees it on the documents step and answers with a `processor_request` upload, and the
-- row names the document that answered it.
--
-- Four decisions shape this file:
--
--   1. The request hangs off the submission the way `0049`'s documents do, through the same
--      composite foreign key, so a request can never be filed under another merchant's submission.
--      `provider_id` is the processor's adapter key (the closed vocabulary of `0029`'s catalogue,
--      checked by the service against the registry); `document_label` is what the provider asked
--      for in its own words, and `note` its optional instruction.
--   2. The status vocabulary is closed: `open` while the merchant has not answered, then exactly
--      one of `fulfilled` (naming the `kyc_documents` row that answered, with its instant) or
--      `cancelled`. The checks make the terminal states honest, and the guard locks them: an
--      answered request is history. Only the `open -> fulfilled` move the merchant's upload makes;
--      the service enforces the same walk, so a double answer conflicts instead of overwriting.
--   3. One open request per (submission, provider, label): the partial unique index makes a repeated
--      provider delivery converge on the first row instead of piling up asks. The open index is the
--      merchant's todo list, ordered by when the ask arrived.
--   4. The guard refuses every delete and soft delete and freezes the merchant, submission,
--      provider, label and note: the ask is evidence of what was required. RLS is default-deny; the
--      app reads and writes through the PostgREST service role key.

begin;

create function public.kyc_document_requests_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a document request is history, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a document request is never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.submission_id is distinct from old.submission_id
       or new.provider_id is distinct from old.provider_id
       or new.document_label is distinct from old.document_label
       or new.note is distinct from old.note then
      raise exception 'a document request keeps its merchant, submission, provider and ask'
        using errcode = 'check_violation';
    end if;

    if old.status in ('fulfilled', 'cancelled')
       and (to_jsonb(new) - 'updated_at' - 'version')
           is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
      raise exception 'an answered or cancelled request is history'
        using errcode = 'check_violation';
    end if;

    if old.status = 'open' and new.status not in ('open', 'fulfilled', 'cancelled') then
      raise exception 'a request moves from open to fulfilled or cancelled only'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.kyc_document_requests_guard_state() is
  'Freezes the ask of a document request, walks open to fulfilled or cancelled, locks the end states and refuses removal.';

create table public.kyc_document_requests (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  submission_id uuid not null,
  provider_id text not null,
  document_label text not null,
  note text,
  status text not null default 'open',
  fulfilled_by uuid,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint kyc_document_requests_pkey primary key (id),
  constraint kyc_document_requests_company_fkey foreign key (company_id) references public.companies (id),
  constraint kyc_document_requests_submission_fkey foreign key (submission_id, company_id)
    references public.kyc_submissions (id, company_id),
  constraint kyc_document_requests_fulfilled_by_fkey foreign key (fulfilled_by) references public.kyc_documents (id),
  constraint kyc_document_requests_provider_check check (provider_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint kyc_document_requests_label_check check (
    char_length(document_label) between 1 and 120 and document_label = btrim(document_label)
  ),
  constraint kyc_document_requests_note_check check (
    note is null or (char_length(note) between 1 and 280 and note = btrim(note))
  ),
  constraint kyc_document_requests_status_check check (status in ('open', 'fulfilled', 'cancelled')),
  constraint kyc_document_requests_open_check check (
    (status = 'open') = (fulfilled_by is null and fulfilled_at is null and cancelled_at is null)
  ),
  constraint kyc_document_requests_fulfilled_check check (
    (status = 'fulfilled') = (fulfilled_by is not null and fulfilled_at is not null and cancelled_at is null)
  ),
  constraint kyc_document_requests_cancelled_check check (
    (status = 'cancelled') = (cancelled_at is not null and fulfilled_by is null and fulfilled_at is null)
  ),
  constraint kyc_document_requests_order_check check (
    (fulfilled_at is null or fulfilled_at >= created_at)
    and (cancelled_at is null or cancelled_at >= created_at)
  ),
  constraint kyc_document_requests_row_version_check check (version > 0),
  constraint kyc_document_requests_updated_check check (updated_at >= created_at),
  constraint kyc_document_requests_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.kyc_document_requests is
  'One extra document a processor asked a merchant for, and the document that answered it.';

comment on column public.kyc_document_requests.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.kyc_document_requests.company_id is
  'The merchant the ask is addressed to. Frozen after the row is written.';

comment on column public.kyc_document_requests.submission_id is
  'The KYC submission the ask belongs to, through the composite key of its merchant.';

comment on column public.kyc_document_requests.provider_id is
  'The adapter key of the processor that asked, from the closed vocabulary of 0029.';

comment on column public.kyc_document_requests.document_label is
  'What the processor asked for, in its own words, at most 120 characters and trimmed.';

comment on column public.kyc_document_requests.note is
  'The processor''s optional instruction, at most 280 characters and trimmed.';

comment on column public.kyc_document_requests.status is
  'open while unanswered, then fulfilled or cancelled. The last two lock the row.';

comment on column public.kyc_document_requests.fulfilled_by is
  'The kyc_documents row that answered the ask, set exactly when the status is fulfilled.';

comment on column public.kyc_document_requests.fulfilled_at is
  'When the answering upload was recorded, required with fulfilled_by.';

comment on column public.kyc_document_requests.cancelled_at is
  'When the ask was withdrawn, required exactly when the status is cancelled.';

comment on column public.kyc_document_requests.created_at is
  'When the ask was recorded.';

comment on column public.kyc_document_requests.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.kyc_document_requests.deleted_at is
  'Never set: the guard refuses the soft delete.';

comment on column public.kyc_document_requests.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One open ask per submission, provider and label: a repeated delivery converges on the first row.
create unique index kyc_document_requests_open_unique
  on public.kyc_document_requests (company_id, submission_id, provider_id, document_label)
  where status = 'open' and deleted_at is null;

-- The merchant's todo list: what still waits for an answer, oldest ask first.
create index kyc_document_requests_open_idx
  on public.kyc_document_requests (company_id, created_at desc)
  where status = 'open' and deleted_at is null;

-- The full history of one submission's asks, newest first.
create index kyc_document_requests_submission_idx
  on public.kyc_document_requests (submission_id, created_at desc)
  where deleted_at is null;

create trigger kyc_document_requests_guard_state
  before insert or update or delete on public.kyc_document_requests
  for each row
  execute function public.kyc_document_requests_guard_state();

create trigger kyc_document_requests_set_row_metadata
  before update on public.kyc_document_requests
  for each row
  execute function public.set_row_metadata();

alter table public.kyc_document_requests enable row level security;

create policy kyc_document_requests_default_deny
  on public.kyc_document_requests
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
