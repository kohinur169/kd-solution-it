-- path: migrations/0122_invoice_fulfilment_evidence.sql
-- STEP 181 - the fulfilment evidence and the buyer confirmation a paid invoice needs before its money
-- may leave the platform.
--
-- Section 16 gives a tokenized invoice link three jobs, and this file carries the record of the third:
-- "opening it shows the paid state and the receipt", "a partly paid invoice accepts only the remainder"
-- and the buyer's confirmation that the goods arrived or the service happened. Section 19 then treats
-- that confirmation as evidence in a chargeback pack, and section 18 refuses to release a settlement
-- until the platform holds it. So the two things this file adds are evidence rather than form fields:
--
--   1. `invoice_fulfilment_evidence` - the merchant's record that the delivery happened, or that the
--      service was performed: kind, method, when, a reference the merchant can quote, and who wrote it.
--   2. `invoice_acceptances` - the buyer's confirmation, with the same eight elements `0027` stores for
--      an estimate signature: name, email, the consent wording and the box, the time, the address, the
--      optional place and device, and the digest of the document that was confirmed.
--
-- ## Why the two are separate tables
--
-- They are written by two different people, at two different moments, from two different sessions. A
-- merchant records a delivery when it happens and may correct a typo in the reference until the buyer has
-- confirmed; the buyer confirms once and never again. One table would have to allow the merchant's edits
-- on rows the buyer's evidence points at, so the two facts are kept apart and joined by an immutable id.
--
-- ## The gates
--
--   * `invoice_acceptances_guard_append_only` refuses every update and every removal, so a confirmation
--     cannot be edited into a different confirmation.
--   * `invoice_acceptances_guard_evidence` refuses a confirmation of an unpaid invoice, a cancelled one,
--     or one whose statement does not match the kind of evidence the merchant recorded. A confirmation
--     of a delivery against a service record is the shape of a mistake that would otherwise be stored as
--     proof.
--   * `invoice_fulfilment_evidence_guard` refuses to rewrite or remove the evidence once a confirmation
--     points at it, because a confirmation that quotes a delivery which has since changed is no longer
--     evidence of anything.
--   * `invoice_release_evidence_ok(company, invoice)` is the one question a payout asks, so no release
--     path has to re implement the rule and no two of them can disagree about it.
--
-- ## What is deliberately absent
--
-- No amount, no currency and no payment reference: the money already lives in `0037`, and a copy of it
-- here would be a second answer to what the invoice was paid. No image, no PDF and no scanned signature:
-- a signature image is a storage key in `0027`, and an acceptance is a typed confirmation rather than an
-- attachment, so nothing binary is stored in this table. No token, no digest of a token and no link: a
-- row here is the fact a link produced, and the link itself is not a fact about the buyer.
--
-- Both tables carry `company_id` and a composite foreign key to `invoices (id, company_id)`, so a row can
-- never be attached to another merchant's document, and both are default-deny under row level security
-- with the platform's service role as the only writer, exactly like every other table in the chain.

begin;

create table public.invoice_fulfilment_evidence (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid not null,
  kind text not null,
  method text not null,
  occurred_at timestamptz not null,
  reference text,
  description text,
  recorded_by_user_id uuid not null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_fulfilment_evidence_pkey primary key (id),
  constraint invoice_fulfilment_evidence_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint invoice_fulfilment_evidence_invoice_fkey foreign key (invoice_id, company_id)
    references public.invoices (id, company_id),
  constraint invoice_fulfilment_evidence_user_fkey foreign key (recorded_by_user_id)
    references public.users (id),
  constraint invoice_fulfilment_evidence_kind_check check (kind in ('delivery', 'service')),
  constraint invoice_fulfilment_evidence_method_check check (
    method in ('carrier', 'hand_delivery', 'pickup', 'digital', 'in_person', 'remote')
  ),
  constraint invoice_fulfilment_evidence_reference_check check (
    reference is null
    or (char_length(reference) between 3 and 120 and reference = btrim(reference))
  ),
  constraint invoice_fulfilment_evidence_description_check check (
    description is null
    or (char_length(description) between 1 and 500 and description = btrim(description))
  ),
  constraint invoice_fulfilment_evidence_occurred_check check (occurred_at <= recorded_at),
  constraint invoice_fulfilment_evidence_version_check check (version > 0),
  constraint invoice_fulfilment_evidence_updated_check check (updated_at >= created_at),
  constraint invoice_fulfilment_evidence_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.invoice_fulfilment_evidence is
  'The merchant record that an invoice was delivered or its service performed, per section 16 and 18.';

comment on column public.invoice_fulfilment_evidence.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.invoice_fulfilment_evidence.company_id is
  'The merchant. Equal to the invoice tenant through the composite foreign key.';

comment on column public.invoice_fulfilment_evidence.invoice_id is
  'The invoice the evidence is about. At most one live row, so a correction replaces its predecessor.';

comment on column public.invoice_fulfilment_evidence.kind is
  'delivery for goods, service for work performed. The buyer statement must match it.';

comment on column public.invoice_fulfilment_evidence.method is
  'How it happened, from the closed list a screen offers: carrier, hand delivery, pickup, digital, in person or remote.';

comment on column public.invoice_fulfilment_evidence.occurred_at is
  'When the delivery or the service actually happened, in server time. Never in the future.';

comment on column public.invoice_fulfilment_evidence.reference is
  'Optional tracking number or job reference the merchant can quote, 3 to 120 characters.';

comment on column public.invoice_fulfilment_evidence.description is
  'Optional sentence about what was delivered, at most 500 characters, never printed on the invoice.';

comment on column public.invoice_fulfilment_evidence.recorded_by_user_id is
  'The merchant account that recorded the evidence. Null is impossible: a system never invents a delivery.';

comment on column public.invoice_fulfilment_evidence.recorded_at is
  'When the evidence was written. Kept apart from occurred_at, which is when the thing happened.';

comment on column public.invoice_fulfilment_evidence.created_at is
  'When the row was first written.';

comment on column public.invoice_fulfilment_evidence.updated_at is
  'Set by the invoice_fulfilment_evidence_set_row_metadata trigger on every update.';

comment on column public.invoice_fulfilment_evidence.deleted_at is
  'Soft delete marker. A corrected row stays readable for the evidence it recorded.';

comment on column public.invoice_fulfilment_evidence.version is
  'Optimistic locking counter. Incremented by the invoice_fulfilment_evidence_set_row_metadata trigger.';

-- One live record per invoice: a correction replaces rather than stacks, so a confirmation always
-- points at the row a merchant currently stands behind.
create unique index invoice_fulfilment_evidence_live_key
  on public.invoice_fulfilment_evidence (invoice_id)
  where deleted_at is null;

create index invoice_fulfilment_evidence_company_idx
  on public.invoice_fulfilment_evidence (company_id, occurred_at desc)
  where deleted_at is null;

create function public.invoice_fulfilment_evidence_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  confirmed boolean;
begin
  select exists (
    select 1
      from public.invoice_acceptances as acceptances
     where acceptances.fulfilment_evidence_id = old.id
       and acceptances.deleted_at is null
  )
    into confirmed;

  if tg_op = 'DELETE' then
    raise exception 'fulfilment evidence is never removed; a correction replaces it'
      using errcode = 'check_violation';
  end if;

  if confirmed
     and (
       new.deleted_at is distinct from old.deleted_at
       or new.kind is distinct from old.kind
       or new.method is distinct from old.method
       or new.occurred_at is distinct from old.occurred_at
       or new.reference is distinct from old.reference
       or new.description is distinct from old.description
     ) then
    raise exception 'fulfilment evidence a buyer confirmed is a fact and cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'a replaced fulfilment record cannot be brought back'
      using errcode = 'check_violation';
  end if;

  if new.invoice_id is distinct from old.invoice_id
     or new.company_id is distinct from old.company_id
     or new.recorded_by_user_id is distinct from old.recorded_by_user_id
     or new.recorded_at is distinct from old.recorded_at then
    raise exception 'the identity of a fulfilment record never moves'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.invoice_fulfilment_evidence_guard() is
  'Refuses removal, identity changes, and any rewrite of a record a buyer has already confirmed.';

create trigger invoice_fulfilment_evidence_guard
  before update or delete on public.invoice_fulfilment_evidence
  for each row
  execute function public.invoice_fulfilment_evidence_guard();

create trigger invoice_fulfilment_evidence_set_row_metadata
  before update on public.invoice_fulfilment_evidence
  for each row
  execute function public.set_row_metadata();

alter table public.invoice_fulfilment_evidence enable row level security;

create policy invoice_fulfilment_evidence_default_deny
  on public.invoice_fulfilment_evidence
  as permissive
  for all
  to public
  using (false)
  with check (false);

create function public.invoice_acceptances_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'invoice acceptances are append only'
    using errcode = 'check_violation';
end;
$$;

comment on function public.invoice_acceptances_guard_append_only() is
  'Refuses every update and every removal of a buyer confirmation, so the evidence cannot be rewritten.';

create function public.invoice_acceptances_guard_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  invoice_status text;
  invoice_paid bigint;
  evidence_kind text;
begin
  select invoices.status, invoices.amount_paid_minor
    into invoice_status, invoice_paid
    from public.invoices as invoices
   where invoices.id = new.invoice_id
     and invoices.company_id = new.company_id
     and invoices.deleted_at is null;

  if invoice_status is null then
    raise exception 'the invoice a confirmation names does not exist'
      using errcode = 'check_violation';
  end if;

  if invoice_status = 'void' then
    raise exception 'a cancelled invoice cannot be confirmed'
      using errcode = 'check_violation';
  end if;

  if invoice_paid is null or invoice_paid <= 0 then
    raise exception 'an invoice with no money received cannot be confirmed'
      using errcode = 'check_violation';
  end if;

  select evidence.kind
    into evidence_kind
    from public.invoice_fulfilment_evidence as evidence
   where evidence.id = new.fulfilment_evidence_id
     and evidence.invoice_id = new.invoice_id
     and evidence.company_id = new.company_id
     and evidence.deleted_at is null;

  if evidence_kind is null then
    raise exception 'a confirmation must name the fulfilment record of its own invoice'
      using errcode = 'check_violation';
  end if;

  if (new.statement = 'delivery_received' and evidence_kind <> 'delivery')
     or (new.statement = 'service_accepted' and evidence_kind <> 'service') then
    raise exception 'the statement a buyer confirms must match the kind of evidence recorded'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.invoice_acceptances_guard_evidence() is
  'Refuses a confirmation of an unpaid or cancelled invoice, or one whose statement contradicts the evidence.';

create table public.invoice_acceptances (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid not null,
  fulfilment_evidence_id uuid not null,
  statement text not null,
  signer_name text not null,
  signer_email text not null,
  consent_text text not null,
  consent_accepted boolean not null,
  accepted_at timestamptz not null default now(),
  ip inet not null,
  geo_location text,
  device_fingerprint text,
  document_hash text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_acceptances_pkey primary key (id),
  constraint invoice_acceptances_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint invoice_acceptances_invoice_fkey foreign key (invoice_id, company_id)
    references public.invoices (id, company_id),
  constraint invoice_acceptances_evidence_fkey foreign key (fulfilment_evidence_id, company_id)
    references public.invoice_fulfilment_evidence (id, company_id),
  constraint invoice_acceptances_statement_check check (
    statement in ('delivery_received', 'service_accepted')
  ),
  constraint invoice_acceptances_signer_name_check check (
    char_length(signer_name) between 1 and 160 and signer_name = btrim(signer_name)
  ),
  constraint invoice_acceptances_signer_email_check check (
    char_length(signer_email) between 3 and 254
    and signer_email = btrim(signer_email)
    and signer_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
  ),
  constraint invoice_acceptances_consent_text_check check (
    char_length(consent_text) between 1 and 2000 and consent_text = btrim(consent_text)
  ),
  constraint invoice_acceptances_consent_check check (consent_accepted),
  constraint invoice_acceptances_geo_check check (
    geo_location is null
    or (char_length(geo_location) between 1 and 200 and geo_location = btrim(geo_location))
  ),
  constraint invoice_acceptances_fingerprint_check check (
    device_fingerprint is null or device_fingerprint ~ '^[!-~]{8,128}$'
  ),
  constraint invoice_acceptances_hash_check check (document_hash ~ '^[a-f0-9]{64}$'),
  constraint invoice_acceptances_agent_check check (
    user_agent is null
    or (char_length(user_agent) between 1 and 400 and user_agent = btrim(user_agent))
  ),
  constraint invoice_acceptances_version_check check (version > 0),
  constraint invoice_acceptances_updated_check check (updated_at >= created_at),
  constraint invoice_acceptances_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.invoice_acceptances is
  'The append only evidence of a buyer confirming delivery or service acceptance of a paid invoice.';

comment on column public.invoice_acceptances.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.invoice_acceptances.company_id is
  'The merchant. Equal to the invoice tenant through the composite foreign key.';

comment on column public.invoice_acceptances.invoice_id is
  'The invoice that was confirmed. One live confirmation per invoice, because the first one ends it.';

comment on column public.invoice_acceptances.fulfilment_evidence_id is
  'The merchant record the buyer was confirming. Immutable: the same pair with the company is the reference.';

comment on column public.invoice_acceptances.statement is
  'delivery received or service accepted, the sentence the buyer ticked. Must match the evidence kind.';

comment on column public.invoice_acceptances.signer_name is
  'The name the buyer typed, trimmed, 1 to 160 characters.';

comment on column public.invoice_acceptances.signer_email is
  'The address the buyer typed, a checked address of at most 254 characters.';

comment on column public.invoice_acceptances.consent_text is
  'The exact consent wording shown beside the checkbox, read from the catalog, at most 2000 characters.';

comment on column public.invoice_acceptances.consent_accepted is
  'The consent checkbox record. Forced true, because an unticked box is not a confirmation.';

comment on column public.invoice_acceptances.accepted_at is
  'When the buyer confirmed, in server time.';

comment on column public.invoice_acceptances.ip is
  'The address the confirmation arrived from, as reported by the request.';

comment on column public.invoice_acceptances.geo_location is
  'Optional place name resolved at confirmation, at most 200 characters.';

comment on column public.invoice_acceptances.device_fingerprint is
  'Optional device fingerprint of the confirming browser, 8 to 128 printable characters.';

comment on column public.invoice_acceptances.document_hash is
  'SHA-256 of the invoice the buyer confirmed, as 64 lower case hex characters.';

comment on column public.invoice_acceptances.user_agent is
  'The browser string of the confirming request, trimmed, at most 400 characters. Never printed.';

comment on column public.invoice_acceptances.created_at is
  'When the evidence row was written.';

comment on column public.invoice_acceptances.updated_at is
  'Present for shape only: no update is possible on this table.';

comment on column public.invoice_acceptances.deleted_at is
  'Present for shape only: no removal is possible on this table.';

comment on column public.invoice_acceptances.version is
  'Optimistic locking counter, always 1 because the guard trigger refuses every update.';

-- One confirmation per invoice. The unchecked index (rather than a partial one) is deliberate: this
-- table can never hold a soft deleted row, and an index that said otherwise would describe a state the
-- guard triggers make impossible.
create unique index invoice_acceptances_invoice_key
  on public.invoice_acceptances (invoice_id);

-- The merchant view: confirmations of one account, newest first.
create index invoice_acceptances_company_idx
  on public.invoice_acceptances (company_id, accepted_at desc);

create trigger invoice_acceptances_guard_evidence
  before insert on public.invoice_acceptances
  for each row
  execute function public.invoice_acceptances_guard_evidence();

create trigger invoice_acceptances_guard_append_only
  before update or delete on public.invoice_acceptances
  for each row
  execute function public.invoice_acceptances_guard_append_only();

alter table public.invoice_acceptances enable row level security;

create policy invoice_acceptances_default_deny
  on public.invoice_acceptances
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The one question a release asks. Section 18 releases a settlement only when the platform holds the
-- evidence, and the evidence is three facts: the invoice is paid, the merchant recorded the fulfilment,
-- and the buyer confirmed it with consent. Written as a function so the payout path, the merchant screen
-- and the handoff read the same rule instead of three approximations of it.
create function public.invoice_release_evidence_ok(p_company_id uuid, p_invoice_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    exists (
      select 1
        from public.invoices as invoices
       where invoices.id = p_invoice_id
         and invoices.company_id = p_company_id
         and invoices.deleted_at is null
         and invoices.status = 'paid'
    )
    and exists (
      select 1
        from public.invoice_fulfilment_evidence as evidence
       where evidence.invoice_id = p_invoice_id
         and evidence.company_id = p_company_id
         and evidence.deleted_at is null
    )
    and exists (
      select 1
        from public.invoice_acceptances as acceptances
       where acceptances.invoice_id = p_invoice_id
         and acceptances.company_id = p_company_id
         and acceptances.deleted_at is null
         and acceptances.consent_accepted
    );
$$;

comment on function public.invoice_release_evidence_ok(uuid, uuid) is
  'True when the invoice is paid, the merchant recorded the fulfilment and the buyer confirmed it.';

commit;
