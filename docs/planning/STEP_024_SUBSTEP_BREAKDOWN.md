// path: docs/planning/STEP_024_SUBSTEP_BREAKDOWN.md
# STEP 024 - Sub-Step Breakdown

The owner asked for three sub-steps again, with an approval between each, so this document is
sub-step 024.1 and it stops for permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_024_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 024 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for payments, refunds and disputes tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 023 created the provider catalogue, the keys, the routing rules, the webhook
  events and the idempotency keys a payment is written under; STEP 021 created the invoices a
  payment settles; STEP 025 creates the double-entry ledger these rows post to; STEP 026 the
  settlements, holds, reserves and payouts. The refund and dispute screens and the processors
  themselves are code STEPs.

### Feature list lines that fix the shape
- Section 18:
  - "Card number, expiry and CVV are entered only inside the provider hosted secure fields. Platform
    code and servers never read, store or track card data or keystrokes."
  - "3D Secure is requested on every payment where possible."
  - "When 3DS is not completed, capture happens only when billing postal code and payer IP country
    both match the invoice data. When either does not match, nothing is captured and the payment
    goes to manual review by compliance_kyc."
  - "A provider fraud signal rejects the payment at once."
  - "Card blacklist entries use card token or provider card fingerprint."
  - "Card and IP velocity limits exist with defaults in config."
  - "The chargeback fee amount is set by super_admin and chargeback losses are taken from the
    sub-merchant balance." "Whether the platform fee is returned on a refund is set by super_admin."
  - "Webhooks are accepted only after signature verification and are processed idempotently."
- Section 19:
  - "Refund interface: request, approval and status tracking."
  - "Dispute interface: list, status and document upload."
  - "The merchant writes the dispute response and supplies the required documents."
  - "The response deadline is 24 hours in the merchant own time zone. super_admin can set the
    deadline to 48 hours when needed."
  - "The merchant receives email warnings at the start and in the middle of the deadline window."
  - "A structured chargeback evidence pack is assembled: invoice, delivery proof, client
    communication record and terms acceptance record."
  - "compliance_kyc reviews the evidence pack and sends it to the processor."
  - "Every refund and dispute action is audit logged."
- Section 10: the platform fee percent and the chargeback fee are settings of super_admin; a payment
  records what was taken from it rather than recomputing a percent months later.
- Section 11: the ledger covers "payment received, platform fee, hold, reserve, settlement, payout,
  refund, chargeback, chargeback fee and subscription charge". The ledger itself is STEP 025.
- Section 27: webhook processing and reconciliation are background jobs, which is why a payment is a
  row with instants and a status rather than a synchronous call.
- MASTER_PROMPT rule 12: "Every payment carries an idempotency key." Rule 9: every mutation writes
  an audit log entry, which the audit STEP already stores generically.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy.

### What exists today (measured before coding)
- Thirty six proven migrations (`0001`-`0036`), 1083 gate checks over thirty six tables, `npm run
  verify` exit 0 at commit `c456688`.
- The pieces a payment points at already exist: `payment_providers` and `provider_keys` (0030),
  `routing_rules` (0031), `idempotency_keys` (0033), and the invoice of STEP 021 with its
  `amount_paid_minor` running total.
- Money in this schema is `bigint` minor units beside a three letter currency, as STEP 018, STEP
  020, STEP 021 and STEP 022 established; the two earlier tables that took money are `invoices` and
  `products`/`services`.

## 2. Design Decisions Taken Before Coding

1. **Three tables in three migrations, `0037`-`0039`.** A payment, a refund against it and a dispute
   about it are three different documents with three different lifetimes, and the STEP title names
   all three.
2. **A payment is one processor transaction, not a running balance.** `amount_minor` is what was
   charged, `fee_minor` what the processor kept, `net_minor` a generated column equal to their
   difference, and `platform_fee_minor` what the platform took. Sums and balances are the ledger's
   (STEP 025) and the invoice's `amount_paid_minor`, not this row's.
3. **Minor units again, with the currency on the row.** MASTER_PROMPT says `numeric(18,4)`; every
   money table in this schema since STEP 018 stores `bigint` minor units beside a three letter
   currency, and a single table in another unit would be the one place where a rounding rule
   differs. The handoff records the deviation explicitly, as the earlier money STEPs did.
4. **Every payment names its idempotency key.** `idempotency_key_id` is not null and unique, so a
   replayed request cannot write a second payment: the unique index is the rule, not the service.
5. **A payment names the route it took.** `provider_id` is required, `provider_key_id` and
   `routing_rule_id` are recorded when they were used, and all three are foreign keys, so a payment
   cannot name a provider that never existed.
6. **Card data is four characters at most.** `card_brand` is a closed vocabulary and
   `card_last_four` is four digits, and there is no column for a number, an expiry, a CVV, a holder
   name or a full token anywhere. Section 18 is therefore a property of the schema.
7. **The 3DS rule is a check.** A payment that reached `captured`, `settled` or a refunded state
   without an authenticated 3DS must carry both `postal_code_matched` and `ip_country_matched`; when
   either is false the row cannot be captured, which is exactly "nothing is captured and the payment
   goes to manual review".
8. **A risk rejection is a failed payment.** `risk_decision` is `allow`, `review` or `reject`, a
   `reject` requires the status `failed` with its instant, and `review` requires the status
   `under_review`, so "a provider fraud signal rejects the payment at once" cannot be stored as a
   successful capture.
9. **Every status carries its own instants.** `authorized` requires `authorized_at`, `captured`
   requires `captured_at`, `settled` requires `settled_at`, `failed` requires `failed_at` and a
   failure code, and the refunded statuses follow `refunded_minor`, which only the refund sync may
   write.
10. **Refunds are capped by the database.** `refunds_guard_amount` refuses a refund whose amount
   plus the live refunds of the same payment exceeds the payment, refuses a refund of a payment that
   was never captured, and refuses a refund that is not in the payment's currency.
11. **The payment follows its refunds.** `refunds_sync_payment` recomputes `refunded_minor` and the
   `partially_refunded` or `refunded` status after every refund write, and the payment guard refuses
   any other writer that touches those two columns, so the total cannot be typed in by hand.
12. **A refund is approved by a person.** `approved_by` and `decided_at` are required exactly when
   the refund has been approved, `succeeded` requires `processed_at`, `failed` requires its detail,
   and a refund is never deleted, because section 19 audits every action.
13. **A dispute is a deadline with an evidence pack.** `response_due_at` is a column, not a computed
   guess, `response_window_hours` is 24 or 48 as section 19 allows, and `evidence_ready` must be
   true before `submitted_at` can be set.
14. **A resolved dispute stays resolved.** `disputes_guard_deadline` refuses a due date later than
   the window allows, refuses a change of the window after the response is submitted, and refuses a
   reopen of a won, lost or closed dispute.
15. **A chargeback fee is a column on the dispute.** Section 18 says super_admin sets it and the
   loss is taken from the merchant balance; the row records the amount and the ledger posts it in
   STEP 025.
16. **RLS on, default deny, nothing forced.** STEP 035 grants the merchant its own payments, refunds
   and disputes and the office the whole list.

Out of scope: the ledger (025), settlements, holds, reserves and payouts (026), the processors and
their adapters, the Collect.js page, the refund and dispute screens, the evidence pack assembly, the
document upload (file storage, 100-105), the reminder emails for the deadline, the velocity limits
and the card blacklist tables (a later STEP), the reconciliation job, migrations `0001` to `0036`,
every `lib/` and `config/` file, and the permissive RLS policies (035).

## 3. The Schema This Produces

### `0037_payments.sql`
- Identity and route: `company_id`, `invoice_id` (null for a store payment that is not invoiced
  yet), `provider_id`, `provider_key_id`, `routing_rule_id`, `idempotency_key_id`, `mode`.
- Money: `amount_minor`, `currency`, `fee_minor`, `net_minor` generated, `platform_fee_minor`,
  `refunded_minor`.
- Method and risk: `payment_method`, `card_brand`, `card_last_four`, `three_ds_outcome`,
  `postal_code_matched`, `ip_country_matched`, `risk_decision`.
- State: `status`, `provider_transaction_id`, `failure_code`, `failure_detail`, `authorized_at`,
  `captured_at`, `settled_at`, `failed_at`, `refunded_at`, plus the five platform columns.
- Unique `idempotency_key_id`; unique `(provider_id, mode, provider_transaction_id)` where the
  transaction id is not null; indexes for the merchant page, the invoice, the under review queue and
  the settlement sweep.
- Checks: the status and method vocabularies, positive amount, non-negative fee not above the
  amount, the 3DS capture rule, the risk rule, the failure pair, the instant per status, the
  refunded pair, the currency shape, four digit tail, and the standard version and timestamp checks.
- Triggers: `payments_guard_refund_state` (only the refund sync may move `refunded_minor` and the
  refunded statuses), `payments_set_row_metadata`.

### `0038_refunds.sql`
- `company_id`, `payment_id`, `amount_minor`, `currency`, `status`, `reason`, `requested_by`,
  `approved_by`, `decided_at`, `processed_at`, `provider_refund_id`, `platform_fee_returned`,
  `platform_fee_returned_minor`, `failure_detail`, plus the five platform columns.
- Unique `(payment_id, provider_refund_id)` where the identifier is not null; indexes for the
  payment, the merchant queue and the status.
- Checks: the status vocabulary, positive amount, a reason of 1 to 500 characters, the approval
  pair, the success and failure instants, the platform fee pair, and the standard checks.
- Triggers: `refunds_guard_amount` (the cap and the captured rule), `refunds_sync_payment` (the
  running total and the payment status), `refunds_set_row_metadata`.

### `0039_disputes.sql`
- `company_id`, `payment_id`, `processor_dispute_id`, `status`, `reason_code`, `amount_minor`,
  `currency`, `fee_minor`, `opened_at`, `response_window_hours`, `response_due_at`,
  `evidence_ready`, `response_text`, `submitted_at`, `resolved_at`, `outcome_note`, plus the five
  platform columns.
- Unique `(company_id, processor_dispute_id)` where the identifier is not null; indexes for the
  deadline queue and the payment.
- Checks: the status vocabulary, positive amount, a window of 24 or 48 hours, a due date after the
  opening instant, evidence ready before submission, a response before the submission instant, the
  resolved instants, and the standard checks.
- Triggers: `disputes_guard_deadline` (the window and the reopen rule), `disputes_set_row_metadata`.

## 4. The Three Sub-Steps

### 024.1 - Inventory, decisions and ownership (this document)
Read sections 10, 11, 18, 19 and 27 and the STEP 023 handoff, measure the thirty six existing
migrations, fix the schema above, and stop for permission.

### 024.2 - `0037_payments.sql` and its rollback
Create the payment with its route, its money, its 3DS and risk rule, its statuses and instants, its
unique idempotency key and provider transaction, its indexes, its refund guard and its metadata
trigger. Prove the refusals, the generated net, one payment per idempotency key, the duplicate
provider transaction, the 3DS capture rule, the risk rejection, the instant per status, the indexes,
all thirty seven rollbacks, and the forward files applying again on a clean database.

### 024.3 - `0038` and `0039`, documentation, verification, commit and handoff
Create the refund and the dispute; then prove section 19 end to end: a refund requested, approved by
a named person and succeeded, the payment's running total and its `partially_refunded` status, a
second refund that would exceed the payment refused, a refund of an uncaptured payment refused, a
direct edit of `refunded_minor` refused, a dispute opened with its 24 hour deadline, a 48 hour
window, an evidence pack that must be ready before submission, a resolved dispute that cannot
reopen, all thirty nine rollbacks emptying `public`, and the thirty nine forward files rebuilding
it. Patch `migrations/README.md` and the root README, run `npm run verify`, prove the gate catches a
removed RLS line, a removed `company_id`, an inserted `truncate` and a missing rollback file, mutate
each guard to watch the proof fail, write `docs/handoffs/STEP_024_COMPLETED.md`, commit as "STEP
024: Migration for payments, refunds and disputes tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0037_payments.sql, .down.sql | created | 024.2 |
| migrations/0038_refunds.sql, .down.sql | created | 024.3 |
| migrations/0039_disputes.sql, .down.sql | created | 024.3 |
| migrations/README.md (the migrations index) | modified | 024.3 |
| README.md (the database section) | modified | 024.3 |
| docs/planning/STEP_024_SUBSTEP_BREAKDOWN.md | this document | 024.1 |
| docs/handoffs/STEP_024_COMPLETED.md | created | 024.3 |

Not owned here: the ledger (025), settlements, holds, reserves and payouts (026), the processor
adapters, the payment page, the refund and dispute screens, the evidence pack assembly, the document
upload and file storage (100-105), the deadline warning emails, the velocity limits and card
blacklist tables, the reconciliation job, the environment schema, the permissive RLS policies (035)
and every code STEP.
