-- path: migrations/0027_estimate_signatures.sql
-- STEP 022 - the evidence of a client's decision on a quote.
--
-- Section 16: "Client approval of an estimate requires a digital signature" and "Signature evidence
-- is stored: signer name, email, consent checkbox record, time, IP address, geo location, device
-- fingerprint and document hash." Section 19 then uses that record as the terms acceptance evidence
-- in a chargeback pack, so it is evidence rather than a form field: every element the sentence names
-- is a column here, and nothing may be edited afterwards.
--
-- The consent is stored as a pair: the exact wording shown and a `consent_accepted` flag that the
-- check forces to true, because an unticked box is not consent and a boolean that can be false is a
-- record of refusal, not of agreement.
--
-- `document_hash` is the SHA-256 of the document the client saw, as 64 lower case hex characters, so
-- a later PDF can be proven to be the one that was signed. `signature_path` is the storage key of a
-- drawn signature image and is filled by the storage STEP; it is a key, never the image itself.
--
-- One quote has at most one signature: the unique index on `estimate_id` says that the first decision
-- ends the question. A row refuses every update and every removal through
-- `estimate_signatures_guard_append_only`, and `estimate_signatures_guard_decision` refuses a
-- signature while the quote is still a draft or already closed, so evidence can only be written at
-- the moment a client could actually have decided.

begin;

create function public.estimate_signatures_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'estimate signatures are append only'
    using errcode = 'check_violation';
end;
$$;

comment on function public.estimate_signatures_guard_append_only() is
  'Refuses every update and every removal of a signature, so the evidence cannot be rewritten.';

create function public.estimate_signatures_guard_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  state text;
begin
  select status into state from public.estimates where id = new.estimate_id;

  if state is distinct from 'sent' and state is distinct from 'viewed' then
    raise exception 'a quote accepts a signature only while it is open'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.estimate_signatures_guard_decision() is
  'Refuses a signature on a quote that is a draft, accepted or void.';

create table public.estimate_signatures (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  estimate_id uuid not null,
  decision text not null,
  signer_name text not null,
  signer_email text not null,
  consent_text text not null,
  consent_accepted boolean not null,
  signed_at timestamptz not null default now(),
  ip inet not null,
  geo_location text,
  device_fingerprint text,
  document_hash text not null,
  signature_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint estimate_signatures_pkey primary key (id),
  constraint estimate_signatures_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint estimate_signatures_estimate_fkey foreign key (estimate_id, company_id)
    references public.estimates (id, company_id),
  constraint estimate_signatures_decision_check check (decision in ('accepted', 'declined')),
  constraint estimate_signatures_signer_name_check check (
    char_length(signer_name) between 1 and 160 and signer_name = btrim(signer_name)
  ),
  constraint estimate_signatures_signer_email_check check (
    char_length(signer_email) between 3 and 254
    and signer_email = btrim(signer_email)
    and signer_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
  ),
  constraint estimate_signatures_consent_text_check check (
    char_length(consent_text) between 1 and 2000 and consent_text = btrim(consent_text)
  ),
  constraint estimate_signatures_consent_check check (consent_accepted),
  constraint estimate_signatures_geo_check check (
    geo_location is null
    or (char_length(geo_location) between 1 and 200 and geo_location = btrim(geo_location))
  ),
  constraint estimate_signatures_fingerprint_check check (
    device_fingerprint is null or device_fingerprint ~ '^[!-~]{8,128}$'
  ),
  constraint estimate_signatures_hash_check check (document_hash ~ '^[a-f0-9]{64}$'),
  constraint estimate_signatures_path_check check (
    signature_path is null
    or (char_length(signature_path) between 1 and 300 and signature_path = btrim(signature_path))
  ),
  constraint estimate_signatures_version_positive_check check (version > 0),
  constraint estimate_signatures_updated_after_creation_check check (updated_at >= created_at),
  constraint estimate_signatures_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.estimate_signatures is
  'The append only evidence of a client accepting or declining a quote, per section 16.';

comment on column public.estimate_signatures.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.estimate_signatures.company_id is
  'The merchant. Equal to the quote tenant through the composite foreign key.';

comment on column public.estimate_signatures.estimate_id is
  'The quote that was decided. Unique, because the first decision ends the question.';

comment on column public.estimate_signatures.decision is
  'accepted or declined, the two decisions section 16 allows a client to make.';

comment on column public.estimate_signatures.signer_name is
  'The name the signer typed, trimmed, 1 to 160 characters.';

comment on column public.estimate_signatures.signer_email is
  'The address the signing link was sent to, a checked address of at most 254 characters.';

comment on column public.estimate_signatures.consent_text is
  'The exact consent wording shown beside the checkbox, trimmed, at most 2000 characters.';

comment on column public.estimate_signatures.consent_accepted is
  'The consent checkbox record. Forced true, because an unticked box is not a signature.';

comment on column public.estimate_signatures.signed_at is
  'When the client signed, in server time.';

comment on column public.estimate_signatures.ip is
  'The address the signature arrived from, as reported by the request.';

comment on column public.estimate_signatures.geo_location is
  'Optional place name resolved at signing, at most 200 characters.';

comment on column public.estimate_signatures.device_fingerprint is
  'Optional device fingerprint of the signing browser, 8 to 128 printable characters.';

comment on column public.estimate_signatures.document_hash is
  'SHA-256 of the signed document as 64 lower case hex characters, so the PDF can be proven later.';

comment on column public.estimate_signatures.signature_path is
  'Optional storage key of a drawn signature image, written by the storage STEP, never the image.';

comment on column public.estimate_signatures.created_at is
  'When the evidence row was written.';

comment on column public.estimate_signatures.updated_at is
  'Present for shape only: no update is possible on this table.';

comment on column public.estimate_signatures.deleted_at is
  'Present for shape only: no removal is possible on this table.';

comment on column public.estimate_signatures.version is
  'Optimistic locking counter, always 1 because the guard trigger refuses every update.';

-- One decision per quote.
create unique index estimate_signatures_estimate_key
  on public.estimate_signatures (estimate_id);

-- The office view: signatures of one merchant, newest first.
create index estimate_signatures_company_idx
  on public.estimate_signatures (company_id, signed_at desc);

create trigger estimate_signatures_guard_decision
  before insert on public.estimate_signatures
  for each row
  execute function public.estimate_signatures_guard_decision();

create trigger estimate_signatures_guard_append_only
  before update or delete on public.estimate_signatures
  for each row
  execute function public.estimate_signatures_guard_append_only();

alter table public.estimate_signatures enable row level security;

create policy estimate_signatures_default_deny
  on public.estimate_signatures
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
