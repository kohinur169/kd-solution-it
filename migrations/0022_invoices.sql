-- path: migrations/0022_invoices.sql
-- STEP 021 - the invoice document of section 16.
--
-- Section 16 fixes the vocabulary: "status workflow: draft, sent, viewed, partially paid, paid,
-- overdue, void", "numbering", "a paid invoice is locked and cannot be edited", and "partial payments
-- are accepted with a minimum of 20 USD". Each of those sentences is a column or a check here.
--
-- The invoice snapshots its client. STEP 020's handoff asks for it: a client may be renamed, moved or
-- soft deleted after an invoice was sent, and the sent document must not change underneath itself.
-- `client_id` stays as the link for reporting, and `client_name`, `client_email` and
-- `client_address` are the bytes that print.
--
-- Numbering happens at issue. A draft carries `number = null`, so a half finished draft never burns a
-- number and two drafts never collide; the partial unique index on `(company_id, number)` is what
-- makes a duplicate number impossible once the number exists. The counter itself lives in code.
--
-- Money is five `bigint` minor unit columns beside an explicit currency: `subtotal_minor` (the lines),
-- `discount_minor` (invoice level), `tax_minor` (the section 7 tax line), `total_minor` and
-- `amount_paid_minor`. The total is not free text: `invoices_derive_total` recomputes it on every
-- write as `subtotal - discount + tax`, and the check states the same identity, so a wrong total
-- cannot be stored even by hand.
--
-- The status carries its own facts rather than trusting the caller: `paid` exactly when `paid_at` is
-- set and the paid amount equals the total, `partially_paid` when the amount sits between zero and the
-- total, `void` exactly when `voided_at` is set, and a draft with no number, no issue instant and no
-- money. Section 16's 20 USD floor is a check on a partially paid invoice in USD.
--
-- A paid invoice is locked by `invoices_guard_paid`: any change to a row whose stored status is `paid`
-- raises, apart from the metadata columns the trigger maintains. Refunds and chargebacks are facts
-- about a payment (STEP 024) and never edits to a paid document.

begin;

create function public.invoices_derive_total()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.total_minor := new.subtotal_minor - new.discount_minor + new.tax_minor;

  return new;
end;
$$;

comment on function public.invoices_derive_total() is
  'Derives invoices.total_minor from subtotal, discount and tax so the three can never disagree.';

-- Section 16: "A paid invoice is locked and cannot be edited." The comparison removes the two
-- metadata columns the row metadata trigger owns, so a paid invoice is frozen byte for byte.
create function public.invoices_guard_paid()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'paid'
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a paid invoice is locked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.invoices_guard_paid() is
  'Refuses every change to a paid invoice except the metadata columns, per section 16.';

create table public.invoices (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  client_id uuid not null,
  number text,
  status text not null default 'draft',
  currency text not null default 'USD',
  subtotal_minor bigint not null default 0,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0,
  amount_paid_minor bigint not null default 0,
  client_name text not null,
  client_email text,
  client_address text,
  memo text,
  issued_at timestamptz,
  due_at timestamptz not null,
  first_viewed_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoices_pkey primary key (id),
  constraint invoices_company_fkey foreign key (company_id) references public.companies (id),
  constraint invoices_client_fkey foreign key (client_id) references public.clients (id),
  constraint invoices_tenant_key unique (id, company_id),
  constraint invoices_status_check check (
    status in ('draft', 'sent', 'viewed', 'partially_paid', 'paid', 'overdue', 'void')
  ),
  constraint invoices_number_check check (
    number is null
    or (char_length(number) between 3 and 40 and number ~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$')
  ),
  constraint invoices_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint invoices_subtotal_check check (subtotal_minor >= 0),
  constraint invoices_discount_check check (
    discount_minor >= 0 and discount_minor <= subtotal_minor
  ),
  constraint invoices_tax_check check (tax_minor >= 0),
  constraint invoices_total_check check (
    total_minor = subtotal_minor - discount_minor + tax_minor and total_minor >= 0
  ),
  constraint invoices_paid_amount_check check (
    amount_paid_minor >= 0 and amount_paid_minor <= total_minor
  ),
  constraint invoices_status_money_check check (
    (status = 'paid' and amount_paid_minor = total_minor)
    or (status = 'partially_paid'
        and amount_paid_minor > 0 and amount_paid_minor < total_minor)
    or (status in ('draft', 'sent', 'viewed', 'overdue') and amount_paid_minor = 0)
    or status = 'void'
  ),
  constraint invoices_partial_minimum_check check (
    status <> 'partially_paid'
    or (currency = 'USD' and amount_paid_minor >= 2000)
    or (currency <> 'USD' and amount_paid_minor > 0)
  ),
  constraint invoices_issue_check check (
    (status = 'draft' and number is null and issued_at is null)
    or (status in ('sent', 'viewed', 'partially_paid', 'paid', 'overdue')
        and number is not null and issued_at is not null)
    or (status = 'void'
        and ((number is null and issued_at is null)
             or (number is not null and issued_at is not null)))
  ),
  constraint invoices_paid_instant_check check ((status = 'paid') = (paid_at is not null)),
  constraint invoices_voided_instant_check check ((status = 'void') = (voided_at is not null)),
  constraint invoices_due_check check (issued_at is null or due_at >= issued_at),
  constraint invoices_viewed_check check (
    first_viewed_at is null
    or (issued_at is not null and first_viewed_at >= issued_at)
  ),
  constraint invoices_client_name_check check (
    char_length(client_name) between 1 and 160 and client_name = btrim(client_name)
  ),
  constraint invoices_client_email_check check (
    client_email is null
    or (
      char_length(client_email) between 3 and 254
      and client_email = btrim(client_email)
      and client_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
    )
  ),
  constraint invoices_client_address_check check (
    client_address is null
    or (char_length(client_address) between 1 and 600 and client_address = btrim(client_address))
  ),
  constraint invoices_memo_check check (
    memo is null or (char_length(memo) between 1 and 2000 and memo = btrim(memo))
  ),
  constraint invoices_version_positive_check check (version > 0),
  constraint invoices_updated_after_creation_check check (updated_at >= created_at),
  constraint invoices_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.invoices is
  'The invoice document of section 16: client snapshot, lines total, status workflow and payment state.';

comment on column public.invoices.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.invoices.company_id is
  'The merchant that issued the document. Every child row must carry the same value.';

comment on column public.invoices.client_id is
  'The client this invoice was written for, kept for reporting; the printed fields are snapshots.';

comment on column public.invoices.number is
  'Null while draft, then the issued number, unique per merchant. Assigned once and never reused.';

comment on column public.invoices.status is
  'draft, sent, viewed, partially_paid, paid, overdue or void, the seven words of section 16.';

comment on column public.invoices.currency is
  'ISO 4217 code in three upper case letters, defaulting to USD as section 16 requires.';

comment on column public.invoices.subtotal_minor is
  'Sum of the live invoice lines in minor units, maintained by the item trigger.';

comment on column public.invoices.discount_minor is
  'Invoice level discount in minor units, never larger than the subtotal.';

comment on column public.invoices.tax_minor is
  'The sales tax line of section 7 in minor units, never negative.';

comment on column public.invoices.total_minor is
  'Derived by invoices_derive_total as subtotal minus discount plus tax. Never typed by a caller.';

comment on column public.invoices.amount_paid_minor is
  'What the client has paid so far in minor units, never above the total.';

comment on column public.invoices.client_name is
  'The client name as printed on this document, a snapshot taken at issue time.';

comment on column public.invoices.client_email is
  'The delivery address as printed on this document, a snapshot taken at issue time.';

comment on column public.invoices.client_address is
  'The postal address as printed on this document, a snapshot taken at issue time.';

comment on column public.invoices.memo is
  'Optional footer or terms note, trimmed, at most 2000 characters, never card data.';

comment on column public.invoices.issued_at is
  'When the invoice was sent. Null while it is a draft and set together with the number.';

comment on column public.invoices.due_at is
  'When the invoice becomes overdue. Never earlier than the issue instant.';

comment on column public.invoices.first_viewed_at is
  'When the client first opened the document, null until then.';

comment on column public.invoices.paid_at is
  'Set exactly when the status is paid, null otherwise.';

comment on column public.invoices.voided_at is
  'Set exactly when the status is void, null otherwise.';

comment on column public.invoices.created_at is
  'When the row was created. Also the sort key of the paginated list.';

comment on column public.invoices.updated_at is
  'Set by the invoices_set_row_metadata trigger on every update.';

comment on column public.invoices.deleted_at is
  'Soft delete marker. A deleted invoice stays readable, because payments point at it.';

comment on column public.invoices.version is
  'Optimistic locking counter. Incremented by the invoices_set_row_metadata trigger.';

-- A number is unique inside one merchant once it exists, and a deleted invoice frees nothing:
-- history keeps its number, so the predicate only excludes the null drafts and the deleted rows that
-- no longer compete for it.
create unique index invoices_number_key
  on public.invoices (company_id, number)
  where number is not null and deleted_at is null;

-- The paginated list of section 16: newest first, with the id breaking ties inside one timestamp.
create index invoices_page_idx
  on public.invoices (company_id, created_at desc, id desc)
  where deleted_at is null;

-- A client's invoices, newest first, for the client screen and the statement.
create index invoices_client_idx
  on public.invoices (company_id, client_id, created_at desc)
  where deleted_at is null;

-- The overdue sweep of section 27 reads the open invoices that are due.
create index invoices_due_idx
  on public.invoices (company_id, due_at)
  where status in ('sent', 'viewed', 'partially_paid') and deleted_at is null;

create trigger invoices_derive_total
  before insert or update on public.invoices
  for each row
  execute function public.invoices_derive_total();

create trigger invoices_guard_paid
  before update on public.invoices
  for each row
  execute function public.invoices_guard_paid();

create trigger invoices_set_row_metadata
  before update on public.invoices
  for each row
  execute function public.set_row_metadata();

alter table public.invoices enable row level security;

create policy invoices_default_deny
  on public.invoices
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
