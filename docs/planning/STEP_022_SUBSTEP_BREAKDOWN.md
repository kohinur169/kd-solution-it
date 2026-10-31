// path: docs/planning/STEP_022_SUBSTEP_BREAKDOWN.md
# STEP 022 - Sub-Step Breakdown

The owner asks for five sub-steps with an approval between each, so this document is sub-step 022.1
and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_022_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 022 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for estimates, estimate signatures and recurring schedules tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 021 created `invoices`, `invoice_items` and `invoice_events`, which this STEP
  converts into; STEP 023 adds providers, credentials and routing; STEP 024 adds payments. The
  recurring job of section 27 and the reminder emails of section 23 read what this STEP stores.

### Feature list lines that fix the shape
- Section 16:
  - "Estimates and quotes exist. Client approval of an estimate requires a digital signature."
  - "Signature evidence is stored: signer name, email, consent checkbox record, time, IP address,
    geo location, device fingerprint and document hash."
  - "A client can decline an estimate, and an estimate expires at its expiry time. Both paths set the
    estimate to void."
  - "When an estimate is accepted it converts automatically into an invoice and a payment link is
    generated."
  - "Recurring invoices exist. When a recurring payment fails there is no automatic retry. The
    invoice shows as due or overdue, reminders go to the client at set intervals, and the merchant
    can take the needed action."
  - "Tokenized links open invoices and estimates for clients."
- Section 19: the chargeback evidence pack includes the terms acceptance record, which for a quote is
  the signature row.
- Section 23: "invoice sent, payment received and failed" and reminder emails are automatic sends.
- Section 27: "Recurring invoice generation and client reminders" is a scheduled job.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy; money is minor units with an explicit currency.

### What exists today (measured before coding)
- Twenty four proven migrations (`0001`-`0024`), 723 gate checks over twenty four tables, `npm run
  verify` exit 0 at commit `28696f9`.
- `invoices` is a locked document with a client snapshot, a derived total, a unique number and an
  append only timeline; `invoice_items` holds the lines and keeps the parent subtotal. Nothing yet
  represents a quote, a signature, or a repeating template.

## 2. Design Decisions Taken Before Coding

1. **Four tables across four migrations.** `0025_estimates`, `0026_estimate_items`,
   `0027_estimate_signatures` and `0028_recurring_schedules`. The STEP title names the three
   documents; `estimate_items` is added because "when an estimate is accepted it converts
   automatically into an invoice" has nothing to convert without lines, and a quote without lines is
   not a quote. It mirrors `invoice_items` exactly, so the pattern is already proven.
2. **An estimate carries the same snapshot rule as an invoice.** `client_name`, `client_email`,
   `client_address` are copied at issue, and `client_id` stays as the link. A quote a client accepted
   last year must read the same today.
3. **The status vocabulary is five words plus a reason.** `draft`, `sent`, `viewed`, `accepted`,
   `void`. Section 16 says a decline and an expiry both set the estimate to void, so
   `void_reason in ('declined', 'expired', 'withdrawn')` is what distinguishes them, and
   `voided_at` records when. `withdrawn` is the merchant cancelling its own quote.
4. **Accepted and void are terminal.** A guard trigger refuses every change to an estimate whose
   stored status is `accepted` or `void`, apart from metadata, exactly as a paid invoice is held shut.
5. **The money identity is the invoice's.** `subtotal_minor`, `discount_minor`, `tax_minor`,
   `total_minor` with the same derive trigger and the same check; there is no paid amount, because a
   quote is never paid.
6. **A quote expires at a stated instant.** `expires_at` is not null and after `issued_at`, so the
   expiry job has a column to read instead of a convention.
7. **Conversion is one link, written once.** `converted_invoice_id` references `invoices(id)`, is
   unique, and may only be set on an accepted estimate, so the same quote cannot produce two invoices
   and a draft cannot claim to have produced one.
8. **A signature is evidence, not a field.** `estimate_signatures` stores the signer name and email,
   the consent text and a `consent_accepted` flag that must be true, the instant, the IP address, the
   geo location, the device fingerprint and the document hash (64 hex characters of a SHA-256). One
   estimate has at most one signature, because the first decision ends the quote.
9. **Signatures and quotes are append only where it matters.** A signature row refuses every update
   and every removal, so the evidence pack of section 19 cannot be rewritten; the estimate's terminal
   statuses are locked by their own trigger.
10. **Recurring invoices run from a template invoice.** `recurring_schedules` points at a draft
    invoice of the same merchant as its template, and the job of section 27 copies that invoice and
    its lines on each run. This keeps the lines in the table that already owns them instead of
    inventing a second catalogue of template lines.
11. **A schedule states its own arithmetic.** `interval_unit in ('day', 'week', 'month', 'year')` with
    `interval_count >= 1`, `start_on`, `next_run_on` and an optional `end_on`, all checked in order;
    `terms_days` is the due offset given to each generated invoice, and the reminder policy is
    `reminder_interval_days` plus `reminder_limit`, because section 16 says reminders go out at set
    intervals while the merchant still has to act.
12. **No automatic retry is a schema fact, not a missing feature.** A schedule has no retry column and
    no attempt counter; a failed recurring payment leaves the invoice due or overdue, which STEP 021
    already models, and section 16's "no automatic retry" stays true by construction.
13. **No token column here.** Section 16's tokenized links are the portal STEP's data (181-190) and
    rule 14 still applies: a token is stored as a hash, never as the token.
14. **RLS on, default deny, nothing forced**, as on the twenty four tables before this one; STEP 035
    grants the merchant its own quotes and schedules and the office the whole list.

## 3. The Schema This Produces

`public.estimates`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant that issued the quote |
| client_id | uuid | not null, references `clients(id)` |
| number | text | null while draft, unique per merchant once issued |
| status | text | `draft`, `sent`, `viewed`, `accepted`, `void` |
| void_reason | text | null, or `declined`, `expired`, `withdrawn` |
| currency | text | not null, default `USD`, three upper case letters |
| subtotal_minor, discount_minor, tax_minor, total_minor | bigint | the invoice identity, derived total |
| client_name, client_email, client_address | text | the snapshot taken at issue |
| memo | text | optional footer, at most 2000 characters |
| issued_at | timestamptz | null while draft, set with the number |
| expires_at | timestamptz | not null, after the issue instant |
| accepted_at | timestamptz | set exactly when the status is `accepted` |
| voided_at | timestamptz | set exactly when the status is `void` |
| converted_invoice_id | uuid | nullable, unique, references `invoices(id)`, only when accepted |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.estimate_items`

The invoice line shape: `id`, `company_id`, `estimate_id`, `position`, `description`, `unit`,
`quantity numeric(12,3)`, `unit_price_minor`, `discount_minor`, the generated `line_total_minor`,
nullable `product_id` and `service_id`, and the audit set. Unique position per estimate, the tenant
pair foreign key `(estimate_id, company_id)`, a catalogue guard and a totals sync trigger that
refuses line changes once the estimate has left `draft`.

`public.estimate_signatures`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, must equal the estimate's tenant |
| estimate_id | uuid | not null, unique, references `(id, company_id)` on `estimates` |
| decision | text | `accepted` or `declined` |
| signer_name | text | 1 to 160 characters, trimmed |
| signer_email | text | a checked address of at most 254 characters |
| consent_text | text | the exact wording shown, 1 to 2000 characters, trimmed |
| consent_accepted | boolean | must be true; an unticked box is not evidence |
| signed_at | timestamptz | not null, the instant of the decision |
| ip | inet | not null |
| geo_location | text | null or at most 200 characters, as resolved at signing |
| device_fingerprint | text | null or 8 to 128 characters of printable text |
| document_hash | text | 64 lower case hex characters, the SHA-256 of the signed document |
| signature_path | text | null or the storage key of the signature image, used by STEP 100 |
| created_at, updated_at, deleted_at, version | audit set | version stays 1, nothing may update a row |

`public.recurring_schedules`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null |
| client_id | uuid | not null, references `clients(id)` |
| template_invoice_id | uuid | not null, unique per merchant, references `invoices(id)` |
| status | text | `active`, `paused`, `ended` |
| interval_unit | text | `day`, `week`, `month`, `year` |
| interval_count | integer | 1 to 60 |
| start_on | date | not null, the first run date |
| next_run_on | date | not null, where the job looks next |
| end_on | date | null, not before the start |
| terms_days | integer | 0 to 365, the due offset of each generated invoice |
| reminder_interval_days | integer | 0 means no reminders, otherwise 1 to 90 |
| reminder_limit | integer | 0 to 10 |
| last_run_on, last_reminder_on | date | null until the first run or reminder |
| paused_at, ended_at | timestamptz | each set exactly with its status |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

Indexes:
- `estimates_number_key` unique on `(company_id, number) where number is not null and deleted_at is null`
- `estimates_tenant_key` unique on `(id, company_id)`, the target of both child foreign keys
- `estimates_page_idx` on `(company_id, created_at desc, id desc) where deleted_at is null`
- `estimates_client_idx` on `(company_id, client_id, created_at desc) where deleted_at is null`
- `estimates_expiry_idx` on `(company_id, expires_at)` where the status is still open
- `estimates_invoice_key` unique on `(converted_invoice_id) where converted_invoice_id is not null`
- `estimate_items_position_key` unique on `(estimate_id, position) where deleted_at is null`
- `estimate_items_product_idx` and `estimate_items_service_idx`, partial on the live rows
- `estimate_signatures_estimate_key` unique on `(estimate_id)`
- `estimate_signatures_company_idx` on `(company_id, signed_at desc)`
- `recurring_schedules_run_idx` on `(next_run_on)` where the status is `active`
- `recurring_schedules_client_idx` on `(company_id, client_id, created_at desc)`
- `recurring_schedules_template_key` unique on `(company_id, template_invoice_id) where deleted_at is null`

## 4. The Five Sub-Steps

### 022.1 - Inventory, decisions and ownership (this document)
Read sections 16, 19, 23 and 27, the STEP 021 handoff and the twenty four existing migrations; measure
what exists; fix the schema above; stop for permission.

### 022.2 - `0025_estimates.sql` and its rollback
Create the estimate with its five statuses, its reason vocabulary, the four instants, the derived
total, the number, the snapshot fields, the conversion link and the terminal guard, plus its six
indexes, RLS, policy and comments. Prove a draft, a sent quote, an accepted one with its converted
invoice, a declined and an expired one through the reason column, a duplicate number, a wrong status
and an edit refused after acceptance.

### 022.3 - `0026_estimate_items.sql` and its rollback
Create the line table with its generated total, its position uniqueness, its tenant pair foreign key,
its catalogue guard and its totals sync trigger. Prove fractional quantities, the refusals, and that
the subtotal follows the lines while the quote is a draft and stops following them once it is sent.

### 022.4 - `0027_estimate_signatures.sql`, `0028_recurring_schedules.sql` and the cross-table proof
Create the evidence table and the schedule table, then prove section 16 end to end: a quote with
lines, a signature that accepts it, the conversion into an invoice whose lines came from the quote, a
declined quote, the immutability of both the signature and the accepted quote, the schedule template
rule, the interval checks, all twenty eight rollbacks emptying `public`, and the twenty eight forward
files rebuilding it.

### 022.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, prove the
gate catches a removed RLS line, a removed `company_id`, an inserted `truncate` and a missing rollback
file, mutate a check and each guard trigger to watch the proof fail, write
`docs/handoffs/STEP_022_COMPLETED.md`, commit as "STEP 022: Migration for estimates, estimate
signatures and recurring schedules tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0025_estimates.sql, .down.sql | created | 022.2 |
| migrations/0026_estimate_items.sql, .down.sql | created | 022.3 |
| migrations/0027_estimate_signatures.sql, .down.sql | created | 022.4 |
| migrations/0028_recurring_schedules.sql, .down.sql | created | 022.4 |
| migrations/README.md (the migrations index) | modified | 022.5 |
| README.md (the database section) | modified | 022.5 |
| docs/planning/STEP_022_SUBSTEP_BREAKDOWN.md | this document | 022.1 |
| docs/handoffs/STEP_022_COMPLETED.md | created | 022.5 |

Not owned here: payments, refunds and disputes (024), the ledger (025), the PDF renderer, the estimate
and schedule screens, the signature capture UI, the recurring and reminder job, the portal token and
its tokenized link (181-190), the file storage adapter (100-105), the permissive RLS policies (035)
and every code STEP.
