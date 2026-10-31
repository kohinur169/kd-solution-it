// path: docs/planning/STEP_026_SUBSTEP_BREAKDOWN.md
# STEP 026 - Sub-Step Breakdown

The owner asked for three sub-steps again, with an approval between each, so this document is
sub-step 026.1 and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_026_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 026 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for settlements, holds, reserves and payouts tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 025 created the ledger these four tables post to and the chart with its
  `reserve_held` account; STEP 024 the payments a settlement collects and a hold may pin; STEP
  022 the invoices those payments settle; STEP 027 the payout bank accounts and bank change
  requests a payout will name. The settlement statement screens, the release job and the
  reconciliation job are code STEPs.
- The STEP plan asks every money STEP for balanced double-entry postings. These four tables are
  the source rows of four ledger source types that already exist: `settlement`, `hold`,
  `reserve` and `payout`.

### Feature list lines that fix the shape
- Section 10:
  - "Platform fee percent is set by super_admin, globally and per sub-merchant when needed."
  - "Settlement hold days are set by super_admin, globally and per sub-merchant when needed."
  - "Rolling reserve exists for risk and negative balance protection. Reserve percent and
    release days are set by super_admin. Reserve terms are shown to the merchant at signup and
    accepted there."
  - "A negative balance is covered first from reserve."
  - "Changing a bank account requires manual verification first. The 96 hour cooling period
    starts only after manual verification passes." and "During the cooling period all payouts
    are fully paused."
  - "Minimum payout amount is 100 USD. Below that amount, funds are paid out as the accumulated
    remainder after the holding period."
  - "Failed payouts are reported to the merchant by email."
  - "Settlement is released automatically after the hold period."
- Section 11: "Ledger covers payment received, platform fee, hold, reserve, settlement, payout,
  refund, chargeback, chargeback fee and subscription charge."
- Section 13: "When a merchant closes the account, remaining money is sent to the bank after the
  hold period, and funds for possible chargeback liability stay held until the chargeback period
  ends."
- Section 17 (statements): "A statement shows payments, fees, holds, reserve, refunds,
  chargebacks and payouts."
- Section 5: `finance_ops` owns "failed payout handling" and "settlement release work", and a
  large payout release needs the CEO confirmation step, so a payout records who released it.
- MASTER_PROMPT: every table carries id UUID v7, company_id, created_at, updated_at, deleted_at,
  version, with RLS enabled and a default-deny policy, and money is minor units beside a
  currency.

### What exists today (measured before coding)
- 41 migrations, 41 tables, 41 policies, 68 triggers, 32 functions in `public`; gate 1233
  checks.
- The ledger chart of `0040` already names the accounts these tables post to:
  `processor_clearing`, `merchant_payable`, `platform_fee_income`, `sales_tax_payable`,
  `reserve_held`, `chargeback_loss`, `chargeback_fee` and `subscription_income`.
- `ledger_entries` accepts the source types `settlement`, `hold`, `reserve` and `payout` with a
  free `source_id` uuid and no foreign key, which is the hook these four tables fill. No
  migration here needs to touch `0041`.
- `payments` carries `amount_minor`, `fee_minor`, `net_minor`, `refunded_minor` and a company,
  and `disputes` carries `amount_minor` and `fee_minor`, so a settlement can be summed from rows
  that exist.
- There is no bank account table until STEP 027 and no config row holding the hold days, the
  reserve percent or the payout minimum: those are super_admin settings that live in `config/`
  and arrive with the settings STEP.

## 2. Design Decisions Taken Before Coding

1. **Four tables, one per word of the title.** `settlements`, `holds`, `reserves` and `payouts`,
   with no settlement line table. Each is the source row of its ledger source type, so the
   statement of section 17 can join the ledger to the row that caused it.
2. **A settlement is a batch, not a payment.** It carries the window it covers, the money it
   collected and the money it owes, all in minor units: `gross_minor`, `refunds_minor`,
   `chargebacks_minor`, `processor_fee_minor`, `platform_fee_minor` and `reserve_minor`.
   `net_minor` is a generated column equal to gross minus the other five, so the batch cannot
   disagree with its parts. A negative net is legal, because section 10 says a negative balance
   is covered from the reserve first, and the check allows it rather than pretending it cannot
   happen.
3. **A settlement states its hold.** `hold_days` is copied onto the row at creation with the
   instant the money becomes releasable (`release_due_at = settled period end + hold_days`), so
   changing the setting later does not move a batch that is already in flight. That is the same
   reasoning STEP 016 used for a price version: a rule that changes must not rewrite history.
4. **A settlement is one processor batch per merchant.** `(company_id, provider_settlement_id)`
   is unique, so a replayed webhook cannot book the same batch twice, and the status vocabulary
   is `pending`, `in_transit`, `settled` and `failed` with an instant for each of the last
   three.
5. **A hold is money kept back, with a reason from a closed list.** `reason` is one of `risk`,
   `dispute`, `billing`, `closure` and `review`, so the statement of section 17 can group holds
   by cause. A hold names the payment it pins when it has one, its `release_due_at`, and the
   person who released it: `released` requires both the instant and the person, `collected`
   requires a note because section 10 collects a shortfall through the contract process.
6. **A reserve is one active account per merchant.** `(company_id)` is unique where the status
   is `active`, with `percent_bps` between 0 and 10000, `release_days` at least 1, `held_minor`
   and `released_minor` with `released_minor <= held_minor`. A reserve row is the running
   account; each release writes a ledger entry whose `source_id` is this row, which is how
   section 10's "release days" stays a rule of the ledger rather than a column that moves.
7. **A payout is a request with a decision.** The status vocabulary is `requested`, `approved`,
   `processing`, `paid`, `failed` and `cancelled`, and each state carries its instant;
   `approved` requires `approved_by` and its instant because section 5 gives the release to
   `finance_ops` with a CEO step for a large amount; `failed` requires a failure code and
   detail, because section 10 emails the merchant. A payout is never deleted after it is paid:
   `paid_at` locks it.
8. **The 100 USD minimum is a check with one exception.** `amount_minor >= 10000` or
   `is_remainder`, and `is_remainder` is only legal when the amount is below the minimum, which
   is section 10's "funds are paid out as the accumulated remainder after the holding period"
   written where it cannot be forgotten.
9. **The destination is a snapshot for now.** STEP 027 owns the bank account table, so a payout
   records `destination_bank_name`, `destination_last_four` and `destination_country` as text,
   and the foreign key to a verified bank account arrives with STEP 027 by adding a column to
   this table. A dangling uuid without its table would be worse than a snapshot, and a snapshot
   is what an audit needs anyway. This is the one open link recorded in the handoff.
10. **No amount is stored twice.** A settlement's net, a payout's net and a reserve's remaining
    amount are all either generated columns or sums; the reserve is the one running balance, and
    it is bounded by its own check rather than by a service's good manners.
11. **Every table is default-deny and every identity is frozen.** A settlement's window, a
    hold's payment, a reserve's percent and a payout's settlement never change after the row is
    written; a guard trigger refuses each of those rewrites, as `0040` and `0037` already do.

## 3. The Schema This Produces

### `0042_settlements.sql`
The window, the six money columns, the generated net, the currency, the hold and the status, plus
the six audit columns: `period_start`, `period_end`,
`gross_minor`, `refunds_minor`, `chargebacks_minor`, `processor_fee_minor`,
`platform_fee_minor`, `reserve_minor`, the generated `net_minor`, `currency`, `hold_days`,
`release_due_at`, `status`, `provider_settlement_id`, `settled_at`, `failed_at`,
`failure_detail`. Checks: every part is not negative, the gross is positive, the window is
ordered, the derived net is the arithmetic, the status vocabulary with its instants, and
`release_due_at` on or after the window end.

### `0043_holds.sql`
`payment_id` and `settlement_id` as optional foreign keys, `amount_minor`, `currency`, the
closed `reason`, `status` of `active`, `released` and `collected`, `placed_at`,
`release_due_at`, `released_at`, `released_by`, `note`. Checks: a released hold carries its
instant and its person, an active hold carries neither, a collected hold carries a note, the
release date is after the placement and the amount is positive. Indexes for the merchant queue
and for what is still held.

### `0044_reserves.sql`
`percent_bps`, `release_days`, `currency`, `held_minor`, `released_minor`, `status` of `active`,
`paused`, `closed`, `started_at`, `closed_at`, `next_release_on`, `note`. Checks: the percent is
a basis point count up to 10000, the release days are at least one, the released total never
exceeds the held total, a closed reserve carries its instant. One partial unique index keeps a
merchant to one active reserve.

### `0045_payouts.sql`
`settlement_id` as an optional foreign key, `amount_minor`, `currency`, `platform_fee_minor`,
the generated `net_minor`, `status`, `requested_by`, `approved_by`, `approved_at`,
`processing_at`, `paid_at`, `failed_at`, `failure_code`, `failure_detail`, `provider_payout_id`,
the three destination snapshot columns, `is_remainder`, `note`. Checks: the amount is positive
and clears the 100 USD floor unless it is the accumulated remainder, the status vocabulary with
its instants, `approved_by` with its instant, a paid payout is locked by a guard, the provider
identifier is unique per merchant and the destination snapshot is complete or absent.

## 4. The Three Sub-Steps

### 026.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list and the STEP 025 handoff; measured the schema; fixed the design
above. No file outside this document is touched. It stops for permission.

### 026.2 - `0042_settlements.sql`, `0043_holds.sql` and their rollbacks
The settlement batch and the hold, with their checks, guards, indexes, comments, RLS and
policies; then a proof script that applies `0001` to `0043`, exercises every rule including a
negative net settled from the reserve, and runs both rollbacks and the re-apply.

### 026.3 - `0044_reserves.sql`, `0045_payouts.sql`, the docs, the verification and the commit
The rolling reserve account and the payout request; then the proof for both, the gate probes,
the behaviour probes, the two README patches, `npm run verify`, the handoff file and the single
commit "STEP 026: Migration for settlements, holds, reserves and payouts tables" with its push.

## 5. Files This STEP Owns
- `migrations/0042_settlements.sql` and `0042_settlements.down.sql`
- `migrations/0043_holds.sql` and `0043_holds.down.sql`
- `migrations/0044_reserves.sql` and `0044_reserves.down.sql`
- `migrations/0045_payouts.sql` and `0045_payouts.down.sql`
- `migrations/README.md` (four inventory rows and up to four rules)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_026_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_026_COMPLETED.md`
- Not owned and not touched: `0001` to `0041`, every `lib/` module, `config/`, the environment
  contract, the settlement statement screens and export, the release job, the reconciliation
  job, the payout bank accounts and bank change requests (027), the permissive RLS policies
  (035) and every code STEP.
