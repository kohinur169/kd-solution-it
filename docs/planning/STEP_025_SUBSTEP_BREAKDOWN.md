// path: docs/planning/STEP_025_SUBSTEP_BREAKDOWN.md
# STEP 025 - Sub-Step Breakdown

The owner asked for three sub-steps again, with an approval between each, so this document is
sub-step 025.1 and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_025_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 025 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for double-entry ledger accounts and ledger entries tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 024 created the payments, refunds and disputes these entries post for; STEP 021
  the invoices whose paid total the postings move; STEP 026 the settlements, holds, reserves and
  payouts that post here. The ledger screens, the reconciliation job and the balance alerts are code
  STEPs.

### Feature list lines that fix the shape
- Section 11:
  - "Every merchant has a full payment ledger."
  - "Double-entry method: every money movement writes a debit entry and a credit entry and the pair
    always balances to zero."
  - "Ledger entries are never edited or deleted. Corrections are written as reversing entries."
  - "Ledger covers payment received, platform fee, hold, reserve, settlement, payout, refund,
    chargeback, chargeback fee and subscription charge."
  - "Merchants see their balance and every entry detail."
  - "The system continuously checks that the ledger is balanced and alerts the office on any
    mismatch."
  - "Reconciliation matches system records with processor reports."
- Section 10: the platform fee, the settlement hold days, the rolling reserve and the chargeback fee
  are super_admin settings; the ledger records what they produced, it does not invent a percent.
- Section 7: collected sales tax is its own line on the invoice and is owed onward, so the ledger
  needs a tax account.
- Section 12: subscription charges are money movements of their own.
- MASTER_PROMPT: "Every STEP that touches money must prove balanced double-entry ledger postings for
  its flows and record the proof in the handoff file." STEP 024 proved the amounts and the refund
  cap and recorded that the postings belong here.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy.

### What exists today (measured before coding)
- Thirty nine proven migrations (`0001`-`0039`), 1173 gate checks over thirty nine tables, `npm run
  verify` exit 0 at commit `b25ff20`.
- `payments` (0037) carries the amount, the processor fee and the platform fee; `refunds` (0038) is
  capped by its payment and syncs the payment's refunded total; `disputes` (0039) carries the
  chargeback amount and its fee; `invoices` (0022) carries `amount_paid_minor` and the
  `partially_paid` and `paid` states that STEP 024 deliberately left unwritten.
- `invoices_guard_paid` refuses any change to a row whose old status is `paid`, which means a
  posting may move an invoice into `paid` but nothing may edit it afterwards, so the ledger tie is
  safe.

## 2. Design Decisions Taken Before Coding

1. **Two tables in two migrations, `0040` and `0041`.** The chart of accounts and the entries that
   post to it are different things: a chart changes once a year, entries never change at all.
2. **A closed chart, not free text.** `account_code` is one of eight codes - `processor_clearing`,
   `merchant_payable`, `platform_fee_income`, `sales_tax_payable`, `reserve_held`,
   `chargeback_loss`, `chargeback_fee` and `subscription_income` - and each row states its kind and
   its normal side. A ninth account is a migration, which is what keeps "the ledger covers payment,
   fee, hold, reserve, settlement, payout, refund, chargeback, chargeback fee and subscription" a
   closed statement.
3. **Kind and side must agree.** An asset or an expense is a debit account, a liability or an income
   is a credit account, and the check refuses any other pairing, because a chart row whose side is
   wrong silently inverts every balance that reads it.
4. **The platform has a chart and every merchant has one.** `company_id` is null for the platform's
   own accounts and set for a merchant's, and two partial unique indexes keep one row per code in
   each scope, since a plain unique index does not dedupe nulls.
5. **A chart row is fixed once written.** The guard refuses a changed code, kind, side or owner, so
   a wrong account is closed and a new code is added, and the entries that pointed at the old one
   still mean what they meant.
6. **An entry is one side of one movement.** `entry_group_id` is the transaction, `entry_side` is
   debit or credit, `amount_minor` is positive, and the deferred constraint trigger refuses a group
   whose debits and credits do not add to the same number, or that has only one side. The balance
   rule is therefore a property of the database and not of the service.
7. **Balance is checked at commit, not per row.** A double entry is written as two inserts, so the
   check is `deferrable initially deferred` and runs when the transaction ends: an unbalanced
   statement cannot commit, and a correct pair in one transaction always does.
8. **A group is one merchant, one currency.** The same trigger refuses a group that mixes two
   currencies or two merchants, because a balanced group in two currencies is not balanced.
9. **An entry names its source.** `source_type` is a closed vocabulary of the ten movements of
   section 11, `source_id` is the row that caused it, and `payment_id`, `refund_id` and `dispute_id`
   are real foreign keys for the three sources this schema already has, paired with checks so the
   wrong one cannot be set.
10. **An entry is never edited or deleted.** `ledger_entries_guard_append_only` refuses every update
   and every removal whatever role asks, which is section 11's sentence in the only place it can be
   enforced.
11. **A correction is a reversal.** `reversal_of_id` names the entry being undone, is unique so one
   entry is reversed once, and a trigger refuses a reversal whose side is not the opposite and whose
   amount is not the same, because that is not a reversal.
12. **Entries are indexed for the three readers.** The merchant statement reads by company and
   occurrence, the account balance reads by account, and the reconciliation reads by source.
13. **The invoice paid total is tied here.** `ledger_entries_sync_invoice` writes
   `invoices.amount_paid_minor` and the `partially_paid` or `paid` state from the posted payment
   entries, which is the link STEP 024 deliberately left open: one writer, at the one moment the
   money is posted, instead of two writers guessing.
14. **RLS on, default deny, nothing forced.** STEP 035 grants the merchant its own entries and the
   office the whole ledger.

Out of scope: settlements, holds, reserves and payouts (026), the ledger screens, the balance
widget, the reconciliation job and its mismatch alerts, the double-entry posting service, the
statement export, the tax collector, the subscription charge job, migrations `0001` to `0039`, every
`lib/` and `config/` file, the permissive RLS policies (035) and every code STEP.

## 3. The Schema This Produces

### `0040_ledger_accounts.sql`
- `company_id` (null for the platform chart), `account_code`, `display_name`, `account_kind`,
  `normal_side`, `is_active`, `opened_at`, `closed_at`, plus the five platform columns.
- Two partial unique indexes: `(account_code)` where `company_id` is null and `deleted_at` is null,
  and `(company_id, account_code)` where `company_id` is not null and `deleted_at` is null.
- Checks: the eight code vocabulary, the four kinds, the two sides, the kind and side pairing, a
  trimmed display name of 1 to 80 characters, `is_active` exactly when `closed_at` is null, and the
  standard version and timestamp checks.
- Triggers: `ledger_accounts_guard_chart` (the code, kind, side and owner are fixed after insert),
  `ledger_accounts_set_row_metadata`.

### `0041_ledger_entries.sql`
- `company_id`, `account_id`, `entry_group_id`, `entry_side`, `amount_minor`, `currency`,
  `occurred_at`, `source_type`, `source_id`, `payment_id`, `refund_id`, `dispute_id`, `description`,
  `reversal_of_id`, `posted_at`, plus the five platform columns.
- Indexes: `(company_id, occurred_at desc, id desc)`, `(account_id, occurred_at)`,
  `(entry_group_id)`, `(source_type, source_id)`, and a unique index on `reversal_of_id`.
- Checks: the two sides, a positive amount, a three letter upper case currency, the ten source
  types, the source pairing for payment, refund and dispute, a trimmed description of at most 280
  characters, and the standard checks.
- Triggers: `ledger_entries_guard_append_only`, `ledger_entries_guard_reversal`,
  `ledger_entries_guard_account` (the account must be the merchant's own or the platform's),
  `ledger_entries_sync_invoice`, the metadata trigger, and the deferred `ledger_entries_balanced`
  constraint trigger.

## 4. The Three Sub-Steps

### 025.1 - Inventory, decisions and ownership (this document)
Read section 11 and the STEP 024 handoff, measure the thirty nine existing migrations, fix the
schema above, and stop for permission.

### 025.2 - `0040_ledger_accounts.sql` and its rollback
Create the chart with its eight codes, its kind and side pairing, its platform and merchant scopes
and its guard. Prove the refusals, the two scopes, the one row per code, the fixed identity, all
forty rollbacks, and the forward files applying again on a clean database.

### 025.3 - `0041_ledger_entries.sql`, documentation, verification, commit and handoff
Create the entries with their balance trigger, their append only and reversal guards, their source
pairing and their invoice tie; then prove section 11 end to end: a payment posts a balanced pair, an
unbalanced group cannot commit, a group in two currencies cannot commit, an entry cannot be edited
or removed, a reversal must mirror its original and only once, a payment moves the invoice's paid
total and its `paid` state, all forty one rollbacks emptying `public`, and the forty one forward
files rebuilding it. Patch `migrations/README.md` and the root README, run `npm run verify`, prove
the gate catches a removed RLS line, a removed `company_id`, an inserted `truncate` and a missing
rollback file, mutate each guard to watch the proof fail, write
`docs/handoffs/STEP_025_COMPLETED.md`, commit as "STEP 025: Migration for double-entry ledger
accounts and ledger entries tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0040_ledger_accounts.sql, .down.sql | created | 025.2 |
| migrations/0041_ledger_entries.sql, .down.sql | created | 025.3 |
| migrations/README.md (the migrations index) | modified | 025.3 |
| README.md (the database section) | modified | 025.3 |
| docs/planning/STEP_025_SUBSTEP_BREAKDOWN.md | this document | 025.1 |
| docs/handoffs/STEP_025_COMPLETED.md | created | 025.3 |

Not owned here: settlements, holds, reserves and payouts (026), the ledger screens, the balance
widget, the reconciliation job and its alerts, the posting service, the statement export, the tax
collector, the subscription charge job, the environment schema, the permissive RLS policies (035)
and every code STEP.
