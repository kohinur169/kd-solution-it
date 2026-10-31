// path: docs/planning/STEP_021_SUBSTEP_BREAKDOWN.md
# STEP 021 - Sub-Step Breakdown

The owner asks for five sub-steps with an approval between each, so this document is sub-step 021.1
and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_021_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 021 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for invoices, invoice items and invoice events tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 020 created `clients`, `products` and `services`, which this STEP references;
  STEP 022 adds `estimates`, `estimate_signatures` and `recurring_schedules`, which convert into an
  invoice; STEP 024 adds `payments`, `refunds` and `disputes`, which point at an invoice; STEP 025
  writes the ledger entries a payment produces.

### Feature list lines that fix the shape
- Section 16, Invoices, Estimates, Recurring Invoices and Payment Links:
  - "Invoice create, edit, duplicate, void, numbering, and status workflow: draft, sent, viewed,
    partially paid, paid, overdue, void."
  - "Line items can be added, edited and ordered correctly. Full discount support."
  - "Partial payments are accepted with a minimum of 20 USD."
  - "A paid invoice is locked and cannot be edited."
  - "Invoices follow a professional format accepted in the United States and globally."
  - "All prices are displayed in USD."
- Section 19: the chargeback evidence pack is "invoice, delivery proof, client communication record
  and terms acceptance record", so an invoice and its history must be readable years later.
- Section 11: every payment writes ledger entries; the invoice is the document those entries explain.
- Section 17: statements show payments against invoices.
- Section 27: "Recurring invoice generation and client reminders" is a scheduled job.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy; money is minor units with an explicit currency.

### What exists today (measured before coding)
- Twenty one proven migrations (`0001`-`0021`), 633 gate checks over twenty one tables.
- The working tree was reset to the base commit by the sandbox between sessions; the branch was
  restored from `origin/arena/aa2e219d-kd-solution-it` at `0365d62`, Node.js 26.13.0 was reinstalled
  from the npm registry package `node-linux-x64`, dependencies were installed and PostgreSQL 16.2 was
  started again from the `pgserver` wheel. `npm run verify` is exit 0 at that commit (633 checks).
- `clients`, `products` and `services` hold the client address, the catalogue snapshot material and
  the price each line will print. Nothing yet represents a document, a line or a timeline.

## 2. Design Decisions Taken Before Coding

1. **Three tables, three migrations, in dependency order.** `0022_invoices.sql` is the document,
   `0023_invoice_items.sql` is its lines, `0024_invoice_events.sql` is its timeline. Rollback runs
   `0024`, `0023`, `0022`.
2. **The invoice snapshots its client.** STEP 020's handoff requires this: a client may be edited or
   soft deleted after an invoice was sent, and a sent document may not change underneath itself. The
   invoice therefore stores `client_name`, `client_email` and `client_address` beside `client_id`,
   which stays as the link for reporting.
3. **The status vocabulary is section 16's, exactly seven words.** `draft`, `sent`, `viewed`,
   `partially_paid`, `paid`, `overdue`, `void`. Each state that needs a fact to be true is a check:
   `void` exactly when `voided_at` is set, `paid` exactly when `paid_at` is set, `draft` has no
   `number`, no `issued_at` and no payments.
4. **Numbering is assigned at issue, not at creation.** A draft carries `number = null`, so half
   finished drafts never consume numbers, and the unique index `(company_id, number)` on the rows that
   have one is the whole guarantee a duplicate number is impossible. The shape is checked; the
   counter lives in code.
5. **Money is five columns with one identity.** `subtotal_minor`, `discount_minor` (invoice level),
   `tax_minor`, `total_minor` and `amount_paid_minor`, all `bigint` minor units beside a three letter
   `currency` that defaults to `USD`. `total = subtotal - discount + tax` is held both by a check and
   by a before trigger that derives it, so a wrong total cannot be stored even by hand.
6. **Paying is a fact, not a status a person can type.** `paid` requires `amount_paid = total`,
   `partially_paid` requires `0 < amount_paid < total`, and every other status except `sent`,
   `viewed` and `overdue` requires `amount_paid = 0` or, for `void`, whatever was already collected.
   A draft cannot hold money.
7. **The 20 USD floor is a check.** Section 16 says partial payments start at 20 USD, so a
   `partially_paid` invoice in USD must carry at least 2000 minor units; a non USD invoice, which
   section 16 does not use today, only has to carry a positive amount rather than being refused
   outright.
8. **A line is a snapshot with an optional reference.** Each item stores `description`, `unit`,
   `quantity`, `unit_price_minor` and `discount_minor`, plus a nullable `product_id` or `service_id`,
   so deleting or repricing a catalogue row never rewrites a sent invoice. At most one of the two
   references may be set.
9. **Quantities are decimal, money is integer.** `quantity numeric(12,3)` because two and a half
   hours is a real line, `unit_price_minor bigint` because money is minor units, and
   `line_total_minor` is a generated column `((quantity * unit_price_minor)::bigint - discount_minor)`
   so the arithmetic is defined once, in the database, with one rounding rule.
10. **An invoice totals itself.** A trigger on the items table recomputes the parent `subtotal_minor`
    and, through the invoices trigger, its `total_minor`; an item may not be added to an invoice that
    has left `draft`. An invoice therefore cannot disagree with its own lines.
11. **Tenant integrity is enforced, not assumed.** Items reference the invoice by the pair
    `(invoice_id, company_id)`, which is why `invoices` carries a unique key on `(id, company_id)`.
    A catalogue reference is verified by a guard trigger, because adding a composite key to `products`
    or `services` would mean editing a migration from an earlier STEP.
12. **A paid invoice is locked by the database.** A before trigger refuses any change to a row whose
    stored status is `paid`, except the metadata columns the trigger itself maintains. Section 16's
    sentence becomes an error, not a convention in the service layer.
13. **The timeline is append only.** `invoice_events` gets a guard trigger that refuses every update
    and every delete, exactly as `audit_logs` does, because the events are what a dispute and a
    support call read months later. Events name their actor (`merchant`, `client`, `office`,
    `system`) and the vocabulary is closed.
14. **No token column here.** Section 16's tokenized link is the portal's data (STEPs 181-190); the
    invoice stores no secret, and rule 14 of this folder (a token is stored as a hash, never as the
    token) is left to the STEP that creates one.
15. **RLS on, default deny, nothing forced**, as on the twenty one tables before this one; STEP 035
    grants the merchant its own invoices and the office the whole list.

## 3. The Schema This Produces

`public.invoices`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant that issued the document |
| client_id | uuid | not null, references `clients(id)`, kept for reporting |
| number | text | null while draft, unique per merchant once issued |
| status | text | the seven words of section 16 |
| currency | text | not null, default `USD`, three upper case letters |
| subtotal_minor | bigint | sum of the live lines, never negative |
| discount_minor | bigint | invoice level discount, never above the subtotal |
| tax_minor | bigint | the tax line of section 7, never negative |
| total_minor | bigint | derived: subtotal minus discount plus tax |
| amount_paid_minor | bigint | never above the total |
| client_name, client_email, client_address | text | the snapshot taken when the document is issued |
| memo | text | optional footer, trimmed, at most 2000 characters |
| issued_at | timestamptz | null while draft, otherwise when it was sent |
| due_at | timestamptz | not null, when it becomes overdue |
| first_viewed_at | timestamptz | null until the client opens the link |
| paid_at | timestamptz | set exactly when the status is `paid` |
| voided_at | timestamptz | set exactly when the status is `void` |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.invoice_items`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, must equal the invoice's tenant |
| invoice_id | uuid | not null, references `(id, company_id)` on `invoices` |
| position | integer | 1 and up, unique inside one invoice |
| description | text | the printed line, 1 to 300 characters, trimmed |
| unit | text | the same seven word list as `products` and `services` |
| quantity numeric(12,3) | decimal | greater than zero, three decimals |
| unit_price_minor | bigint | never negative |
| discount_minor | bigint | never negative, never above the gross line |
| line_total_minor | bigint | generated: `(quantity * unit_price)::bigint - discount` |
| product_id, service_id | uuid | nullable, at most one, the catalogue row it came from |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.invoice_events`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, must equal the invoice's tenant |
| invoice_id | uuid | not null, references `(id, company_id)` on `invoices` |
| type | text | `created`, `sent`, `viewed`, `payment_received`, `paid`, `overdue_reminder`, `voided`, `duplicated`, `note` |
| actor | text | `merchant`, `client`, `office`, `system` |
| actor_user_id | uuid | nullable, references `users(id)` for a person, null for the system |
| detail | text | optional, trimmed, at most 500 characters |
| occurred_at | timestamptz | not null, defaults to now() |
| created_at, updated_at, deleted_at, version | audit set | version stays 1, because nothing may update a row |

Indexes:
- `invoices_number_key` unique on `(company_id, number) where number is not null and deleted_at is null`
- `invoices_tenant_key` unique on `(id, company_id)`, the target of both child foreign keys
- `invoices_page_idx` on `(company_id, created_at desc, id desc) where deleted_at is null`
- `invoices_client_idx` on `(company_id, client_id, created_at desc) where deleted_at is null`
- `invoices_due_idx` on `(company_id, due_at)` where the status is still open, for the overdue sweep
- `invoice_items_position_key` unique on `(invoice_id, position)`
- `invoice_items_product_idx` on `(company_id, product_id) where product_id is not null`
- `invoice_items_service_idx` on `(company_id, service_id) where service_id is not null`
- `invoice_events_timeline_idx` on `(invoice_id, occurred_at desc, id desc)`
- `invoice_events_type_idx` on `(company_id, type, occurred_at desc)`

## 4. The Five Sub-Steps

### 021.1 - Inventory, decisions and ownership (this document)
Read sections 11, 16, 17, 19 and 27, the STEP 020 handoff and the twenty one existing migrations;
restore the sandbox toolchain; measure what exists; fix the schema above; stop for permission.

### 021.2 - `0022_invoices.sql` and its rollback
Create the invoice table with its checks (the seven statuses, the four instants, the five money
columns and their identity, the number shape, the snapshot fields and the memo), its five indexes, the
derived total trigger, the paid lock trigger, the row metadata trigger, RLS and the default-deny
policy, and a comment on every column. Prove a draft, a sent invoice, a partially paid one under the
20 USD floor, a paid one that refuses every edit, a void one, a duplicate number and a wrong status.

### 021.3 - `0023_invoice_items.sql` and its rollback
Create the item table with its generated line total, its position uniqueness, its two catalogue
references, its tenant pair foreign key, the catalogue guard trigger and the totals sync trigger, plus
its three indexes, RLS, policy and comments. Prove fractional quantities, discounts above the gross
line, a duplicate position, a cross tenant invoice, a cross tenant catalogue row, and that an item
added to a sent invoice is refused while the invoice totals follow a draft.

### 021.4 - `0024_invoice_events.sql`, its rollback and the cross-table proof
Create the append-only timeline, then prove section 16 end to end: a draft with three lines totalling
a known amount, sending it assigning a number, a client view recorded, a 20 USD partial payment moving
the status and the amount, the final payment locking the invoice, a void invoice with its instant, the
events timeline in order, RLS on all three tables, all twenty four rollbacks emptying `public`, and the
twenty four forward files rebuilding it.

### 021.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, prove the
gate catches a removed RLS line, a removed `company_id`, an inserted `truncate` and a missing rollback
file, mutate a check and a trigger to watch the proof fail, write
`docs/handoffs/STEP_021_COMPLETED.md`, commit as "STEP 021: Migration for invoices, invoice items and
invoice events tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0022_invoices.sql, .down.sql | created | 021.2 |
| migrations/0023_invoice_items.sql, .down.sql | created | 021.3 |
| migrations/0024_invoice_events.sql, .down.sql | created | 021.4 |
| migrations/README.md (the migrations index) | modified | 021.5 |
| README.md (the database section) | modified | 021.5 |
| docs/planning/STEP_021_SUBSTEP_BREAKDOWN.md | this document | 021.1 |
| docs/handoffs/STEP_021_COMPLETED.md | created | 021.5 |

Not owned here: estimates, estimate signatures and recurring schedules (022), payments, refunds and
disputes (024), the ledger (025), the PDF renderer, the invoice screens, the reminder job, the portal
tokenized link and its token (181-190), the permissive RLS policies (035) and every code STEP.
