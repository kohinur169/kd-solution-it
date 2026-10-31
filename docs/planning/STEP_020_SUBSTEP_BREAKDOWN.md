// path: docs/planning/STEP_020_SUBSTEP_BREAKDOWN.md
# STEP 020 - Sub-Step Breakdown

The owner asked for five sub-steps with an approval between each, so this document is sub-step 020.1
and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_020_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 020 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for clients, products and services tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 019 created `subscriptions` and `subscription_charges`; STEP 021 creates
  `invoices`, `invoice_items` and `invoice_events`, which reference the client and the catalogue
  item this STEP creates; STEP 022 adds estimates for the same clients.

### Feature list lines that fix the shape
- Section 15, Clients, Products and Data Import:
  - "Client create, edit, delete and paginated list."
  - "Product and service create, edit, delete and paginated list."
  - "CSV data import for client and product lists. Invalid rows are reported row by row while valid
    rows are imported."
- Section 16: line items carry a quantity and a unit price, invoices are issued to a client, and
  "All prices are displayed in USD".
- Section 7: sales tax is calculated per transaction through the merchant's own TaxCloud account, so
  a client may carry a tax identifier; the tax engine itself is not this STEP.
- Section 25 (roles): "owner: one account per person and per business. Manages own business, clients,
  products, invoices, ..." so both tables are tenant tables with a real `company_id`.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy; money is minor units with an explicit currency.

### What exists today (measured before coding)
- Eighteen proven migrations (`0001`-`0018`), 543 gate checks over eighteen tables, and
  `npm run verify` green at STEP 019.
- `companies` is the tenant root, `plans`/`plan_entitlements`/`pricing_versions` are platform
  catalogue objects, and `subscriptions`/`subscription_charges` are the merchant's billing. There is
  no table yet for the people a merchant invoices or for the things it sells.

## 2. Design Decisions Taken Before Coding

1. **Three tables, three migrations, in dependency order.** `0019_clients.sql`, `0020_products.sql`
   and `0021_services.sql`, each with its `.down.sql`. None references another, so the rollbacks run
   in any order, but they are numbered and rolled back in reverse like every earlier STEP.
2. **A client belongs to one merchant.** `company_id` is `not null` and references `companies(id)`.
   Two merchants may invoice the same person independently: nothing is shared between tenants.
3. **Delete means soft delete.** Section 15 says "delete", and STEP 021 will reference a client from
   an invoice. `deleted_at` is the marker; the row stays, the invoice stays explainable, and the
   partial unique indexes stop counting a deleted row, so a mistyped client can be removed and the
   same email used again.
4. **An email is unique per merchant, not per platform.** The unique index is
   `(company_id, lower(email)) where deleted_at is null and email is not null`, so `Sam@Example.com`
   and `sam@example.com` are the same client to one merchant while another merchant keeps its own
   row. No extension is created: the index uses `lower()` rather than `citext`, because rule 9 of
   this folder forbids extensions.
5. **A client carries the fields an invoice needs and no more.** Name, optional business name, email,
   phone, a postal address in five parts, an optional tax identifier and a notes field. The address is
   all-or-nothing from line 1 downwards: a city without a street line is refused, which is the shape
   mistake a CSV import makes most often.
6. **Currency is explicit on a price.** Both catalogue tables store `unit_price_minor bigint` with a
   three letter `currency` that defaults to `USD`, because section 16 fixes the display currency and
   a default keeps the common case honest without forbidding a later decision.
7. **Products and services are separate tables.** A product is a good identified by a SKU, a service
   is work identified by a code and billed by time. Keeping them apart keeps each table's vocabulary
   honest; STEP 021 stores a snapshot of the name and price on the line item anyway, so a line can
   point at either table with one nullable foreign key per kind.
8. **A unit is a small closed vocabulary.** `unit` is one of `item`, `unit`, `hour`, `day`, `week`,
   `month`, `project`, defaulting to `item` on a product and `hour` on a service, because the invoice
   prints it next to the quantity and "2 hour" has to read the same way everywhere.
9. **A price is never negative and never a float.** `unit_price_minor >= 0` and a three upper case
   letter currency, matching the rule every earlier money column follows. Zero is allowed: a
   complimentary line is a real invoice line.
10. **Codes are unique per merchant while live.** `products.sku` and `services.code` are optional,
    shaped (`^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`), and unique per merchant under `lower()` while the
    row is not deleted, so a retired SKU can be reused deliberately and a duplicate cannot be entered
    by accident.
11. **Every list query has an index of its own.** A page of clients or products for one merchant is
    `(company_id, created_at desc, id desc)` filtered on `deleted_at is null`; a search by name is
    `(company_id, lower(name))`, which is also the natural sort order.
12. **RLS on, default deny, nothing forced**, as on the previous eighteen tables; STEP 035 grants the
    merchant their own rows and the office the whole list.

## 3. The Schema This Produces

`public.clients`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant who owns this client |
| name | text | not null, 1 to 120 characters, trimmed |
| company_name | text | null or 1 to 160 characters, trimmed, the client's business |
| email | text | null or a checked address of at most 254 characters |
| phone | text | null or 5 to 31 characters of digits, space, brackets, dot or hyphen |
| address_line1 | text | null or 1 to 160 characters, trimmed |
| address_line2 | text | null or 1 to 160 characters, trimmed |
| city | text | null or 1 to 80 characters, trimmed |
| region | text | null or 1 to 80 characters, trimmed, the state or province |
| postal_code | text | null or 3 to 16 characters |
| country | text | null or two upper case letters, ISO 3166-1 alpha-2 |
| tax_id | text | null or at most 32 characters, trimmed, used by the tax STEP |
| notes | text | null or at most 2000 characters, trimmed |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.products`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant catalogue this product belongs to |
| name | text | not null, 1 to 160 characters, trimmed |
| sku | text | null or at most 48 characters of letters, digits, dot, underscore, hyphen |
| description | text | null or at most 2000 characters, trimmed |
| unit_price_minor | bigint | not null, never negative, minor units |
| currency | text | not null, default `USD`, three upper case letters |
| unit | text | not null, default `item`, one of the seven unit words |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.services`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant catalogue this service belongs to |
| name | text | not null, 1 to 160 characters, trimmed |
| code | text | null or at most 48 characters of letters, digits, dot, underscore, hyphen |
| description | text | null or at most 2000 characters, trimmed |
| unit_price_minor | bigint | not null, never negative, minor units |
| currency | text | not null, default `USD`, three upper case letters |
| unit | text | not null, default `hour`, one of the seven unit words |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

Indexes:
- `clients_email_key` unique on `(company_id, lower(email)) where deleted_at is null and email is not null`
- `clients_page_idx` on `(company_id, created_at desc, id desc) where deleted_at is null`
- `clients_name_idx` on `(company_id, lower(name)) where deleted_at is null`
- `products_sku_key` unique on `(company_id, lower(sku)) where deleted_at is null and sku is not null`
- `products_page_idx` on `(company_id, created_at desc, id desc) where deleted_at is null`
- `products_name_idx` on `(company_id, lower(name)) where deleted_at is null`
- `services_code_key` unique on `(company_id, lower(code)) where deleted_at is null and code is not null`
- `services_page_idx` on `(company_id, created_at desc, id desc) where deleted_at is null`
- `services_name_idx` on `(company_id, lower(name)) where deleted_at is null`

## 4. The Five Sub-Steps

### 020.1 - Inventory, decisions and ownership (this document)
Read section 15 with its neighbours in sections 7 and 16, the STEP 019 handoff and the eighteen
existing migrations; measure what exists; fix the schema above; stop for permission.

### 020.2 - `0019_clients.sql` and its rollback
Create the client table with its three indexes, its checks (name, business name, email shape and
length, phone shape, address completeness, country, postal code, tax identifier, notes), its trigger,
RLS and default-deny policy, and a comment on every column.

### 020.3 - `0020_products.sql` and its rollback
Create the product table with its checks (name, SKU shape and length, description, non-negative
price, currency, unit vocabulary), its three indexes, its trigger, RLS and policy, and its comments.

### 020.4 - `0021_services.sql`, its rollback and the cross-table proof
Create the service table in the same shape with `code` and the `hour` default, then prove the three
tables together: unique email per merchant in both cases, reuse of an address or SKU after a soft
delete, address completeness, every refused shape by name, pagination order, RLS on all three, all
twenty one rollbacks emptying `public`, and the twenty one forward files rebuilding it.

### 020.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` (three inventory rows and the rules that this STEP establishes) and the
root README database section, run `npm run verify`, prove the gate catches a removed RLS line, a
removed `company_id`, an inserted `truncate` and a missing rollback file, mutate one check to watch
the proof fail, write `docs/handoffs/STEP_020_COMPLETED.md`, commit as "STEP 020: Migration for
clients, products and services tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0019_clients.sql, .down.sql | created | 020.2 |
| migrations/0020_products.sql, .down.sql | created | 020.3 |
| migrations/0021_services.sql, .down.sql | created | 020.4 |
| migrations/README.md (the migrations index) | modified | 020.5 |
| README.md (the database section) | modified | 020.5 |
| docs/planning/STEP_020_SUBSTEP_BREAKDOWN.md | this document | 020.1 |
| docs/handoffs/STEP_020_COMPLETED.md | created | 020.5 |

Not owned here: the invoice, its line items and client snapshot (021), the estimates for these
clients (022), the CSV import job and its row-by-row report, the client portal pages, the product and
client screens, the permissive RLS policies (035), the tax calculation itself and every code STEP.
