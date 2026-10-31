-- path: migrations/0026_estimate_items.sql
-- STEP 022 - one printed line of a quote.
--
-- Section 16 gives a quote the same anatomy as an invoice: it is a document a client reads and then
-- accepts or declines, and "when an estimate is accepted it converts automatically into an invoice".
-- A conversion has nothing to copy without lines, so this table mirrors `invoice_items` exactly: the
-- description, the unit, the decimal quantity and the price are snapshots, the optional `product_id`
-- and `service_id` keep the link for reporting, and the arithmetic is the same generated column.
--
-- The quote totals itself in the same way. `estimate_items_sync_totals` recomputes the parent
-- `subtotal_minor` after every change and `public.invoices_derive_total()` turns that into
-- `total_minor`, so a stored quote cannot disagree with the lines the client read. The same trigger
-- refuses any change once the quote has left `draft`, because a quote that a client is deciding on
-- must not move under them, and acceptance is already frozen by `estimates_guard_terminal`.
--
-- Tenancy is a foreign key: the line points at its quote through `(estimate_id, company_id)`, and a
-- catalogue reference is checked by `estimate_items_guard_catalogue`, since `products` and `services`
-- carry no composite key they could be referenced by.

begin;

create function public.estimate_items_guard_catalogue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.estimate_id <> old.estimate_id or new.company_id <> old.company_id) then
    raise exception 'a line cannot move to another quote'
      using errcode = 'check_violation';
  end if;

  if new.product_id is not null and not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.company_id = new.company_id
  ) then
    raise exception 'a product from another merchant cannot be quoted'
      using errcode = 'check_violation';
  end if;

  if new.service_id is not null and not exists (
    select 1 from public.services s
    where s.id = new.service_id and s.company_id = new.company_id
  ) then
    raise exception 'a service from another merchant cannot be quoted'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.estimate_items_guard_catalogue() is
  'Keeps a quote line inside its own quote and its own catalogue.';

create function public.estimate_items_sync_totals()
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
    target := old.estimate_id;
  else
    target := new.estimate_id;
  end if;

  select status into state from public.estimates where id = target;

  if state is distinct from 'draft' then
    raise exception 'lines of an issued estimate are locked'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(line_total_minor), 0) into lines_total
  from public.estimate_items
  where estimate_id = target and deleted_at is null;

  update public.estimates set subtotal_minor = lines_total where id = target;

  return null;
end;
$$;

comment on function public.estimate_items_sync_totals() is
  'Recomputes the quote subtotal from the live lines and refuses line changes on an issued quote.';

create table public.estimate_items (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  estimate_id uuid not null,
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
  constraint estimate_items_pkey primary key (id),
  constraint estimate_items_company_fkey foreign key (company_id) references public.companies (id),
  constraint estimate_items_estimate_fkey foreign key (estimate_id, company_id)
    references public.estimates (id, company_id),
  constraint estimate_items_product_fkey foreign key (product_id) references public.products (id),
  constraint estimate_items_service_fkey foreign key (service_id) references public.services (id),
  constraint estimate_items_position_check check (position >= 1),
  constraint estimate_items_description_check check (
    char_length(description) between 1 and 300 and description = btrim(description)
  ),
  constraint estimate_items_unit_check check (
    unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')
  ),
  constraint estimate_items_quantity_check check (quantity > 0 and quantity <= 1000000),
  constraint estimate_items_unit_price_check check (unit_price_minor >= 0),
  constraint estimate_items_discount_check check (
    discount_minor >= 0
    and discount_minor <= greatest((quantity * unit_price_minor)::bigint, 0)
  ),
  constraint estimate_items_source_check check (num_nonnulls(product_id, service_id) <= 1),
  constraint estimate_items_version_positive_check check (version > 0),
  constraint estimate_items_updated_after_creation_check check (updated_at >= created_at),
  constraint estimate_items_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.estimate_items is
  'The printed lines of a quote: a snapshot of the catalogue plus the arithmetic of the line.';

comment on column public.estimate_items.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.estimate_items.company_id is
  'The merchant. Equal to the quote tenant through the composite foreign key.';

comment on column public.estimate_items.estimate_id is
  'The quote this line belongs to, referenced together with company_id.';

comment on column public.estimate_items.position is
  'One based print order inside one quote, unique among the live lines.';

comment on column public.estimate_items.description is
  'What the client reads on the line, trimmed, 1 to 300 characters.';

comment on column public.estimate_items.unit is
  'The same seven word unit list as products and services, printed beside the quantity.';

comment on column public.estimate_items.quantity is
  'Decimal quantity with three places, greater than zero, so two and a half hours is a line.';

comment on column public.estimate_items.unit_price_minor is
  'Price of one unit in minor units, never negative.';

comment on column public.estimate_items.discount_minor is
  'Discount in minor units, never larger than the gross line.';

comment on column public.estimate_items.line_total_minor is
  'Generated: quantity times unit price, rounded to minor units, minus the discount. Non negative by construction.';

comment on column public.estimate_items.product_id is
  'The product the line came from, optional and checked against the same merchant.';

comment on column public.estimate_items.service_id is
  'The service the line came from, optional and checked against the same merchant.';

comment on column public.estimate_items.created_at is
  'When the line was added.';

comment on column public.estimate_items.updated_at is
  'Set by the estimate_items_set_row_metadata trigger on every update.';

comment on column public.estimate_items.deleted_at is
  'Soft delete marker. A removed line stops counting towards the quote subtotal.';

comment on column public.estimate_items.version is
  'Optimistic locking counter. Incremented by the estimate_items_set_row_metadata trigger.';

-- One line per position inside a quote, for the live lines only.
create unique index estimate_items_position_key
  on public.estimate_items (estimate_id, position)
  where deleted_at is null;

-- The reporting question: which quote lines came from this product.
create index estimate_items_product_idx
  on public.estimate_items (company_id, product_id)
  where product_id is not null and deleted_at is null;

-- The reporting question: which quote lines came from this service.
create index estimate_items_service_idx
  on public.estimate_items (company_id, service_id)
  where service_id is not null and deleted_at is null;

create trigger estimate_items_guard_catalogue
  before insert or update on public.estimate_items
  for each row
  execute function public.estimate_items_guard_catalogue();

create trigger estimate_items_set_row_metadata
  before update on public.estimate_items
  for each row
  execute function public.set_row_metadata();

create trigger estimate_items_sync_totals
  after insert or update or delete on public.estimate_items
  for each row
  execute function public.estimate_items_sync_totals();

alter table public.estimate_items enable row level security;

create policy estimate_items_default_deny
  on public.estimate_items
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
