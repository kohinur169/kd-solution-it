-- path: migrations/0023_invoice_items.sql
-- STEP 021 - one printed line of an invoice.
--
-- Section 16: "Line items can be added, edited and ordered correctly. Full discount support." A line
-- is a snapshot: the description, the unit, the quantity and the unit price are copied onto it, so a
-- product renamed to something else next year never rewrites an invoice that was already sent. The
-- optional `product_id` and `service_id` keep the link for reporting, and at most one of them is set.
--
-- The arithmetic is defined once, here. `quantity` is `numeric(12,3)` because two and a half hours is
-- a real line, the money is `bigint` minor units, and `line_total_minor` is a generated column
-- `((quantity * unit_price_minor)::bigint - discount_minor)`, so the rounding rule cannot differ
-- between the service that writes a line and the query that reads one. A discount may not exceed the
-- gross line, which keeps every total at or above zero.
--
-- An invoice totals itself. `invoice_items_sync_totals` recomputes the parent `subtotal_minor` after
-- every insert, edit or removal of a line, and `invoices_derive_total` turns that into `total_minor`,
-- so a stored invoice can never disagree with the lines a client sees. The same trigger refuses any
-- change to the lines of an invoice that has left `draft`, because section 16 locks the document and a
-- sent invoice whose lines move under the client is exactly the dispute this design exists to avoid.
--
-- Tenancy is a foreign key, not a convention: the line points at its invoice through the pair
-- `(invoice_id, company_id)`, so a row cannot join another merchant's invoice. A catalogue reference
-- is checked by `invoice_items_guard_catalogue`, because `products` and `services` were created in an
-- earlier STEP and cannot gain a composite key without editing that STEP's file.

begin;

create function public.invoice_items_guard_catalogue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.invoice_id <> old.invoice_id or new.company_id <> old.company_id) then
    raise exception 'a line cannot move to another invoice'
      using errcode = 'check_violation';
  end if;

  if new.product_id is not null and not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.company_id = new.company_id
  ) then
    raise exception 'a product from another merchant cannot be billed'
      using errcode = 'check_violation';
  end if;

  if new.service_id is not null and not exists (
    select 1 from public.services s
    where s.id = new.service_id and s.company_id = new.company_id
  ) then
    raise exception 'a service from another merchant cannot be billed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.invoice_items_guard_catalogue() is
  'Keeps a line inside its own invoice and its own catalogue, since those tables carry no composite key.';

create function public.invoice_items_sync_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target uuid;
  state text;
  lines_total bigint;
begin
  if tg_op = 'DELETE' then
    target := old.invoice_id;
  else
    target := new.invoice_id;
  end if;

  select status into state from public.invoices where id = target;

  if state is distinct from 'draft' then
    raise exception 'lines of an issued invoice are locked'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(line_total_minor), 0) into lines_total
  from public.invoice_items
  where invoice_id = target and deleted_at is null;

  update public.invoices set subtotal_minor = lines_total where id = target;

  return null;
end;
$$;

comment on function public.invoice_items_sync_totals() is
  'Recomputes the parent subtotal from the live lines and refuses line changes on an issued invoice.';

create table public.invoice_items (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid not null,
  position integer not null,
  description text not null,
  unit text not null default 'item',
  quantity numeric(12,3) not null,
  unit_price_minor bigint not null,
  discount_minor bigint not null default 0,
  line_total_minor bigint generated always as
    ((quantity * unit_price_minor)::bigint - discount_minor) stored,
  product_id uuid,
  service_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_items_pkey primary key (id),
  constraint invoice_items_company_fkey foreign key (company_id) references public.companies (id),
  constraint invoice_items_invoice_fkey foreign key (invoice_id, company_id)
    references public.invoices (id, company_id),
  constraint invoice_items_product_fkey foreign key (product_id) references public.products (id),
  constraint invoice_items_service_fkey foreign key (service_id) references public.services (id),
  constraint invoice_items_position_check check (position >= 1),
  constraint invoice_items_description_check check (
    char_length(description) between 1 and 300 and description = btrim(description)
  ),
  constraint invoice_items_unit_check check (
    unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')
  ),
  constraint invoice_items_quantity_check check (quantity > 0 and quantity <= 1000000),
  constraint invoice_items_unit_price_check check (unit_price_minor >= 0),
  constraint invoice_items_discount_check check (
    discount_minor >= 0
    and discount_minor <= greatest((quantity * unit_price_minor)::bigint, 0)
  ),
  constraint invoice_items_source_check check (num_nonnulls(product_id, service_id) <= 1),
  constraint invoice_items_version_positive_check check (version > 0),
  constraint invoice_items_updated_after_creation_check check (updated_at >= created_at),
  constraint invoice_items_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.invoice_items is
  'The printed lines of an invoice: a snapshot of the catalogue plus the arithmetic of the line.';

comment on column public.invoice_items.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.invoice_items.company_id is
  'The merchant. Equal to the invoice tenant through the composite foreign key.';

comment on column public.invoice_items.invoice_id is
  'The invoice this line belongs to, referenced together with company_id.';

comment on column public.invoice_items.position is
  'One based print order inside one invoice, unique among the live lines.';

comment on column public.invoice_items.description is
  'What the client reads on the line, trimmed, 1 to 300 characters.';

comment on column public.invoice_items.unit is
  'The same seven word unit list as products and services, printed beside the quantity.';

comment on column public.invoice_items.quantity is
  'Decimal quantity with three places, greater than zero, so two and a half hours is a line.';

comment on column public.invoice_items.unit_price_minor is
  'Price of one unit in minor units, never negative.';

comment on column public.invoice_items.discount_minor is
  'Discount in minor units, never larger than the gross line.';

comment on column public.invoice_items.line_total_minor is
  'Generated: quantity times unit price, rounded to minor units, minus the discount. Non negative by construction.';

comment on column public.invoice_items.product_id is
  'The product the line came from, optional and checked against the same merchant.';

comment on column public.invoice_items.service_id is
  'The service the line came from, optional and checked against the same merchant.';

comment on column public.invoice_items.created_at is
  'When the line was added.';

comment on column public.invoice_items.updated_at is
  'Set by the invoice_items_set_row_metadata trigger on every update.';

comment on column public.invoice_items.deleted_at is
  'Soft delete marker. A removed line stops counting towards the subtotal.';

comment on column public.invoice_items.version is
  'Optimistic locking counter. Incremented by the invoice_items_set_row_metadata trigger.';

-- One line per position inside an invoice, for the live lines only, so removing a line frees its
-- place and reordering cannot hit a dead row.
create unique index invoice_items_position_key
  on public.invoice_items (invoice_id, position)
  where deleted_at is null;

-- The reporting question: which lines came from this product.
create index invoice_items_product_idx
  on public.invoice_items (company_id, product_id)
  where product_id is not null and deleted_at is null;

-- The reporting question: which lines came from this service.
create index invoice_items_service_idx
  on public.invoice_items (company_id, service_id)
  where service_id is not null and deleted_at is null;

create trigger invoice_items_guard_catalogue
  before insert or update on public.invoice_items
  for each row
  execute function public.invoice_items_guard_catalogue();

create trigger invoice_items_set_row_metadata
  before update on public.invoice_items
  for each row
  execute function public.set_row_metadata();

create trigger invoice_items_sync_totals
  after insert or update or delete on public.invoice_items
  for each row
  execute function public.invoice_items_sync_totals();

alter table public.invoice_items enable row level security;

create policy invoice_items_default_deny
  on public.invoice_items
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
