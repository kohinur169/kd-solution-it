-- path: migrations/0025_estimates.sql
-- STEP 022 - the estimate, or quote, of section 16.
--
-- Section 16: "Estimates and quotes exist. Client approval of an estimate requires a digital
-- signature." and "A client can decline an estimate, and an estimate expires at its expiry time. Both
-- paths set the estimate to void." and "When an estimate is accepted it converts automatically into an
-- invoice and a payment link is generated."
--
-- The quote therefore shares the invoice's identity rules and differs where a quote really differs:
-- it has no paid amount, it carries an `expires_at`, its terminal state is a decision rather than a
-- payment, and acceptance is recorded with a conversion. `void_reason` separates the three ways a
-- quote can end (declined by the client, expired, withdrawn by the merchant), because section 16
-- deliberately uses one status for the first two.
--
-- The client fields are snapshots, taken when the quote is issued, for the same reason as on the
-- invoice: a client may be edited later and a document that was accepted must still read as it read.
--
-- `converted_invoice_id` is the conversion, written once. It may only be set on an accepted quote and
-- it is unique, so one quote cannot produce two invoices and a draft cannot claim to have produced
-- one.
--
-- Acceptance and void are terminal. `estimates_guard_terminal` refuses every change to a row whose
-- stored status is `accepted` or `void` apart from the metadata columns, so a signature can never be
-- outrun by an edit to the document it signed.
--
-- The total is derived by `public.invoices_derive_total()`, the same function the invoice uses: the
-- identity `total = subtotal - discount + tax` is defined once in this schema, not once per document.

begin;

-- A decided quote is frozen. The comparison removes the metadata columns the row metadata trigger
-- owns, so acceptance and void are stamps, not doors.
create function public.estimates_guard_terminal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('accepted', 'void')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a decided estimate is locked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.estimates_guard_terminal() is
  'Refuses every change to an accepted or void estimate except the metadata columns.';

create table public.estimates (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  client_id uuid not null,
  number text,
  status text not null default 'draft',
  void_reason text,
  currency text not null default 'USD',
  subtotal_minor bigint not null default 0,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0,
  client_name text not null,
  client_email text,
  client_address text,
  memo text,
  issued_at timestamptz,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  voided_at timestamptz,
  converted_invoice_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint estimates_pkey primary key (id),
  constraint estimates_company_fkey foreign key (company_id) references public.companies (id),
  constraint estimates_client_fkey foreign key (client_id) references public.clients (id),
  constraint estimates_invoice_fkey foreign key (converted_invoice_id) references public.invoices (id),
  constraint estimates_tenant_key unique (id, company_id),
  constraint estimates_status_check check (
    status in ('draft', 'sent', 'viewed', 'accepted', 'void')
  ),
  constraint estimates_void_reason_check check (
    void_reason is null or void_reason in ('declined', 'expired', 'withdrawn')
  ),
  constraint estimates_void_pair_check check ((status = 'void') = (void_reason is not null)),
  constraint estimates_number_check check (
    number is null
    or (char_length(number) between 3 and 40 and number ~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$')
  ),
  constraint estimates_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint estimates_subtotal_check check (subtotal_minor >= 0),
  constraint estimates_discount_check check (
    discount_minor >= 0 and discount_minor <= subtotal_minor
  ),
  constraint estimates_tax_check check (tax_minor >= 0),
  constraint estimates_total_check check (
    total_minor = subtotal_minor - discount_minor + tax_minor and total_minor >= 0
  ),
  constraint estimates_issue_check check (
    (status = 'draft' and number is null and issued_at is null)
    or (status in ('sent', 'viewed', 'accepted')
        and number is not null and issued_at is not null)
    or (status = 'void'
        and ((number is null and issued_at is null)
             or (number is not null and issued_at is not null)))
  ),
  constraint estimates_accepted_instant_check check (
    (status = 'accepted') = (accepted_at is not null)
  ),
  constraint estimates_voided_instant_check check ((status = 'void') = (voided_at is not null)),
  constraint estimates_expiry_check check (issued_at is null or expires_at > issued_at),
  constraint estimates_conversion_check check (
    converted_invoice_id is null or status = 'accepted'
  ),
  constraint estimates_client_name_check check (
    char_length(client_name) between 1 and 160 and client_name = btrim(client_name)
  ),
  constraint estimates_client_email_check check (
    client_email is null
    or (
      char_length(client_email) between 3 and 254
      and client_email = btrim(client_email)
      and client_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
    )
  ),
  constraint estimates_client_address_check check (
    client_address is null
    or (char_length(client_address) between 1 and 600 and client_address = btrim(client_address))
  ),
  constraint estimates_memo_check check (
    memo is null or (char_length(memo) between 1 and 2000 and memo = btrim(memo))
  ),
  constraint estimates_version_positive_check check (version > 0),
  constraint estimates_updated_after_creation_check check (updated_at >= created_at),
  constraint estimates_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.estimates is
  'The quote of section 16: client snapshot, lines total, a decision, an expiry and one conversion.';

comment on column public.estimates.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.estimates.company_id is
  'The merchant that issued the quote. Every child row must carry the same value.';

comment on column public.estimates.client_id is
  'The client the quote was written for, kept for reporting; the printed fields are snapshots.';

comment on column public.estimates.number is
  'Null while draft, then the issued number, unique per merchant and never reused.';

comment on column public.estimates.status is
  'draft, sent, viewed, accepted or void: a quote is decided once and then frozen.';

comment on column public.estimates.void_reason is
  'declined, expired or withdrawn when the status is void, null otherwise.';

comment on column public.estimates.currency is
  'ISO 4217 code in three upper case letters, defaulting to USD as section 16 requires.';

comment on column public.estimates.subtotal_minor is
  'Sum of the live quote lines in minor units, maintained by the item trigger.';

comment on column public.estimates.discount_minor is
  'Quote level discount in minor units, never larger than the subtotal.';

comment on column public.estimates.tax_minor is
  'The sales tax line of section 7 in minor units, never negative.';

comment on column public.estimates.total_minor is
  'Derived by invoices_derive_total as subtotal minus discount plus tax, exactly like an invoice.';

comment on column public.estimates.client_name is
  'The client name as printed on the quote, a snapshot taken at issue time.';

comment on column public.estimates.client_email is
  'The delivery address as printed on the quote, a snapshot taken at issue time.';

comment on column public.estimates.client_address is
  'The postal address as printed on the quote, a snapshot taken at issue time.';

comment on column public.estimates.memo is
  'Optional footer or terms note, trimmed, at most 2000 characters, never card data.';

comment on column public.estimates.issued_at is
  'When the quote was sent. Null while it is a draft and set together with the number.';

comment on column public.estimates.expires_at is
  'When the quote expires, always after the issue instant. The expiry job reads this column.';

comment on column public.estimates.accepted_at is
  'Set exactly when the status is accepted, and with the signature that accepted it.';

comment on column public.estimates.voided_at is
  'Set exactly when the status is void, whichever of the three reasons ended the quote.';

comment on column public.estimates.converted_invoice_id is
  'The invoice this accepted quote became. Unique, so one quote produces at most one invoice.';

comment on column public.estimates.created_at is
  'When the row was created. Also the sort key of the paginated list.';

comment on column public.estimates.updated_at is
  'Set by the estimates_set_row_metadata trigger on every update.';

comment on column public.estimates.deleted_at is
  'Soft delete marker. A deleted quote stays readable, because its signature and invoice point at it.';

comment on column public.estimates.version is
  'Optimistic locking counter. Incremented by the estimates_set_row_metadata trigger.';

-- A number is unique inside one merchant once it exists; drafts carry none and deleted rows compete
-- for nothing.
create unique index estimates_number_key
  on public.estimates (company_id, number)
  where number is not null and deleted_at is null;

-- The paginated list of section 16: newest first, with the id breaking ties inside one timestamp.
create index estimates_page_idx
  on public.estimates (company_id, created_at desc, id desc)
  where deleted_at is null;

-- A client's quotes, newest first, for the client screen.
create index estimates_client_idx
  on public.estimates (company_id, client_id, created_at desc)
  where deleted_at is null;

-- The expiry sweep of section 27 reads the quotes that are still open.
create index estimates_expiry_idx
  on public.estimates (company_id, expires_at)
  where status in ('sent', 'viewed') and deleted_at is null;

-- One invoice per quote.
create unique index estimates_invoice_key
  on public.estimates (converted_invoice_id)
  where converted_invoice_id is not null;

create trigger estimates_derive_total
  before insert or update on public.estimates
  for each row
  execute function public.invoices_derive_total();

create trigger estimates_guard_terminal
  before update on public.estimates
  for each row
  execute function public.estimates_guard_terminal();

create trigger estimates_set_row_metadata
  before update on public.estimates
  for each row
  execute function public.set_row_metadata();

alter table public.estimates enable row level security;

create policy estimates_default_deny
  on public.estimates
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
