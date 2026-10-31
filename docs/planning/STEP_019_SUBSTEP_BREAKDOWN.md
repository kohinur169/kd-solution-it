// path: docs/planning/STEP_019_SUBSTEP_BREAKDOWN.md
# STEP 019 - Sub-Step Breakdown

The owner asked for this STEP to be written in a single pass instead of one approval per sub-step,
so the five parts below are recorded as planned and then executed in one turn. The proof belongs in
`docs/handoffs/STEP_019_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 019 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for subscriptions and subscription charges table".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 018 created `plans` (the thing a subscription buys), `plan_entitlements` and
  `pricing_versions`; STEP 020 onwards build the invoicing and payment tables. STEP 013 owns the
  merchant account, STEP 014 the audit trail that a billing event must produce.

### Feature list lines that fix the shape
- Section 12, Platform Subscription Billing:
  - "Subscription is charged first from the merchant balance."
  - "When the balance is empty, the saved card is charged."
  - "The saved card is stored and charged through the super admin platform sub-merchant account."
  - "Saving a card requires an explicit future-charge consent (mandate). Consent text, version, time
    and IP are recorded."
  - "Warnings start 7 days before the due date."
  - "When balance and card charges both fail on the due date, all services stop at once."
  - "Login, the billing payment page and support stay open while services are stopped."
  - "As soon as payment succeeds, all services are enabled again automatically."
- Section 13: a merchant stopped for unpaid billing can log in and pay, and services are enabled as
  soon as payment succeeds; closed and suspended records are retained.
- Section 23: "subscription warnings and service stop and restore notices" are automatic emails.
- Section 27: "Subscription charge attempts and the 7 day advance warnings" is a scheduled job.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy; money is minor units with an explicit currency.

### What exists today (measured before coding)
- Sixteen proven migrations (`0001`-`0018`) and 483 gate checks over sixteen tables.
- `plans` holds `price_minor`, `currency`, `period` and a status; `plan_entitlements` says which
  services a plan includes; `pricing_versions` holds the fee schedule in force. Nothing yet binds a
  merchant to a plan, nothing records a billing attempt, and nothing can stop the services.

## 2. Design Decisions Taken Before Coding

1. **Two tables, two migrations.** `0017_subscriptions.sql` is the agreement, `0018_subscription_charges.sql`
   is the attempt record. The second references the first, rollback runs in reverse order.
2. **A subscription is per merchant, and a merchant has one live subscription.**
   `company_id` is `not null`, and a partial unique index allows one row per company while it is not
   cancelled, so two billing paths can never run for the same merchant at once.
3. **The price is not copied onto the subscription.** STEP 018's handoff says a running subscription
   must read the price list in force rather than a snapshot; the charge row records what was actually
   charged, which is the number an invoice and a dispute need. The plan reference is `plan_id`.
4. **The period is explicit.** `current_period_start` and `current_period_end` bound the cycle being
   billed, `next_due_at` is when the next attempt is due, and checks keep the three in order. A
   monthly plan may be billed on any day of the month, so the period is data, not arithmetic.
5. **The status vocabulary is the section 12 story.** `pending` (created, not yet charging),
   `active` (paid and running), `past_due` (warnings started, still running), `stopped` (balance and
   card both failed, services off) and `cancelled` (ended by the merchant or the office). Each
   transition has its own instant: `activated_at`, `warning_sent_at`, `stopped_at`, `resumed_at`,
   `cancelled_at`.
6. **The seven day warning is a constraint.** `warning_sent_at` may not be earlier than seven days
   before `current_period_end`, so a warning sent twenty days early (the mistake that trains users
   to ignore warnings) is refused.
7. **Stopping and resuming are recorded, not inferred.** `stopped_at` and `resumed_at` are columns
   with their order checked, so "when did services stop" and "when did they come back" are answerable
   without reconstructing an event log.
8. **The mandate lives on the subscription, in four columns.** Section 12 requires the consent text,
   its version, the time and the IP to be recorded before a card may be charged in the future. The
   four are set together or not at all, one check enforces that, and the text is bounded and trimmed.
   The STEP that stores card tokens (023) will reference this row rather than invent a second consent.
9. **A charge records a split, not a single source.** `balance_used_minor` and `card_used_minor` are
   both stored, because section 12 charges the balance first and only the remainder from the card.
   A succeeded charge must add up to `amount_minor` exactly; a failed one must add up to zero. That
   is one check per state, and it makes the "balance first" rule visible in the data.
10. **Retries are rows.** `attempt_number` counts attempts inside one period, and the pair
    `(subscription_id, period_start, attempt_number)` is unique, so a retry after a failed card is a
    second row, not an overwrite of the first. The history of a failed billing is exactly what a
    support call needs.
11. **Failure has a small vocabulary.** `failure_code` is one of `insufficient_balance`,
    `card_declined`, `no_card`, `mandate_missing`, `provider_error`; `failure_detail` holds at most
    280 characters of operator text and never a card number. A failed charge must carry a code, and a
    succeeded one must not.
12. **RLS on, default deny, nothing forced**, as on the previous sixteen tables; STEP 035 grants the
    merchant their own billing rows and the office the whole ledger of charges.
13. **No new function and no extension.** The helpers from `0001` are reused.

## 3. The Schema This Produces

`public.subscriptions`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant being billed |
| plan_id | uuid | not null, references `plans(id)` |
| status | text | `pending`, `active`, `past_due`, `stopped` or `cancelled` |
| current_period_start | timestamptz | not null, the start of the cycle being billed |
| current_period_end | timestamptz | not null, the due instant, after the start |
| next_due_at | timestamptz | not null, when the next attempt is scheduled |
| activated_at | timestamptz | null until the first successful charge |
| warning_sent_at | timestamptz | null until the seven day warning is sent |
| stopped_at | timestamptz | null until balance and card both failed |
| resumed_at | timestamptz | null until a payment restores the services |
| cancelled_at | timestamptz | null while the subscription is live |
| mandate_text | text | null until a card is saved, 1 to 2000 characters, trimmed |
| mandate_version | text | null until a card is saved, a short version label |
| mandate_accepted_at | timestamptz | null until the merchant consents |
| mandate_ip | inet | null until the merchant consents |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.subscription_charges`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | not null, the merchant being charged |
| subscription_id | uuid | not null, references `subscriptions(id)` |
| period_start, period_end | timestamptz | the cycle this attempt pays for |
| attempt_number | integer | starts at 1, counts retries inside one period |
| amount_minor | bigint | greater than zero, minor units |
| currency | text | three upper case letters |
| status | text | `pending`, `succeeded` or `failed` |
| balance_used_minor | bigint | never negative, what the balance covered |
| card_used_minor | bigint | never negative, what the card covered |
| failure_code | text | null unless the attempt failed |
| failure_detail | text | null, at most 280 characters, never a card number |
| completed_at | timestamptz | null while pending, otherwise the outcome instant |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

## 4. The Five Sub-Steps (executed in one pass at the owner's request)

### 019.1 - Inventory, decisions and ownership (this document)
Read sections 12, 13, 23 and 27, the STEP 018 handoff and the sixteen existing migrations; measure
what exists; fix the schema above.

### 019.2 - `0017_subscriptions.sql` and its rollback
Create the subscription table with its eight indexes and checks, trigger, RLS and policy, plus
comments: one live subscription per merchant, a period in order, a warning that cannot arrive more
than seven days early, the five status values, and the all-or-nothing mandate quartet.

### 019.3 - `0018_subscription_charges.sql` and its rollback
Create the charge table with its checks, the unique attempt index, the retry index, trigger, RLS and
policy, plus comments: one attempt per period and number, a success that adds up and a failure that
does not, a failure code exactly when failed, and a currency on every row.

### 019.4 - Cross-table proof, RLS and the gate
Prove section 12 end to end in data: a subscription bound to a plan, a charge that uses the balance
first and the card for the remainder, a failed attempt that stops the services, a retry that
succeeds and resumes them, the seven day warning window, the mandate quartet, one live subscription
per merchant, RLS on both tables, all eighteen migrations rolled back in reverse and re-applied, and
the gate with its mutation probes.

### 019.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, write
`docs/handoffs/STEP_019_COMPLETED.md`, commit as "STEP 019: Migration for subscriptions and
subscription charges table", push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0017_subscriptions.sql, .down.sql | created in 019.2 |
| migrations/0018_subscription_charges.sql, .down.sql | created in 019.3 |
| migrations/README.md (the migrations index) | modified in 019.5 |
| README.md (the database section) | modified in 019.5 |
| docs/planning/STEP_019_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_019_COMPLETED.md | created in 019.5 |

Not owned here: card tokens and mandates as card data (023), the balance itself and the ledger (025),
the invoice that a charge produces (021), the billing page UI, the warning job, the permissive RLS
policies (035) and every code STEP.
