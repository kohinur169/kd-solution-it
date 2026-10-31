// path: docs/handoffs/STEP_024_COMPLETED.md
# STEP 024 Completed - Handoff

## STEP
- Number and title: STEP 024 - Migration for payments, refunds and disputes tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 023 (the providers, the
  keys, the routing rules and the idempotency keys a payment names), STEP 021 (the invoices a
  payment settles and the `amount_paid_minor` running total) and STEP 020 (the clients an invoice
  snapshots). STEP 025 adds the double-entry ledger these rows post to, STEP 026 the settlements,
  holds, reserves and payouts, and STEP 035 the permissive policies. The owner asked for three
  sub-steps with one approval between each, and the plan is
  `docs/planning/STEP_024_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0037_payments.sql and 0037_payments.down.sql - the processor transaction with its
    provider, key, routing rule and unique idempotency key, its amount, fee and generated net, its
    four card characters, its 3DS capture rule, its risk rule, its status instants and its refund
    state guard.
  - migrations/0038_refunds.sql and 0038_refunds.down.sql - the refund document with its request,
    approval and processing states, the guard that caps it against its payment, and the sync that
    writes the payment's refunded total and status.
  - migrations/0039_disputes.sql and 0039_disputes.down.sql - the chargeback with its opening
    instant, its 24 or 48 hour window, its evidence flag, its response and submission, its resolved
    outcome and its deadline guard.
  - docs/planning/STEP_024_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_024_COMPLETED.md.
- Modified:
  - migrations/README.md - three inventory rows and two new rules: a payment is one processor
    transaction with a route, and a refund is capped by its payment while a dispute is a deadline.
    The numbering rule moved from 33 to 36.
  - README.md - the database section describes the payment, the refund and the dispute, directly
    above the `uuid_generate_v7()` bullet.
  - docs/handoffs/STEP_021_COMPLETED.md - one sentence corrected: the invoice's `amount_paid_minor`
    is written by the ledger STEP (025), which is the single owner of money aggregation, and not by
    this STEP. Two triggers writing the same column would be two truths.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0036`, every
  `lib/` module, `config/`, the environment contract, the ledger (025), settlements, holds, reserves
  and payouts (026), the processor adapters, the payment page, the refund and dispute screens, the
  evidence pack assembly, document upload and file storage (100-105), the deadline warning emails,
  the velocity and card blacklist tables, the reconciliation job, the permissive RLS policies (035)
  and every code STEP. `package.json` is untouched because the migrations gate already covers new
  files.

## Database
- Migrations added (file names): `0037_payments`, `0038_refunds` and `0039_disputes`, each with its
  `.down.sql`. Together they create three tables, 74 columns, 73 constraints, fifteen indexes, 77
  comments, four functions and seven triggers. The schema now holds thirty nine tables, thirty nine
  policies, sixty one triggers and twenty six functions in `public`.
- Shape per table: `payments` 34 columns, 35 constraints, seven indexes, 35 comments, two triggers;
  `refunds` 19 columns, 18 constraints, four indexes, 20 comments, three triggers; `disputes` 21
  columns, 20 constraints, four indexes, 22 comments, two triggers.
- Money is `bigint` minor units beside a three letter currency, as every money table since STEP 018.
  MASTER_PROMPT rule 2 says `numeric(18,4)`; this schema stores minor units so that no float and no
  rounding rule can differ between two tables, and STEP 018, STEP 020, STEP 021 and STEP 022 already
  recorded the same decision. `net_minor` is a generated column, so the net of a payment can never
  disagree with its amount and its fee.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All thirty nine
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the thirty nine forward
  files applied again to a second empty database, recreating exactly thirty nine tables, thirty nine
  policies, sixty one triggers and twenty six functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic card brands, a made
  up four digit tail, synthetic processor identifiers and a synthetic refund reason in throwaway
  local databases, and no real card, provider key, TaxCloud account or store token was written
  anywhere.
- The working tree survived from STEP 023 at commit `c456688`; Node.js 26.13.0, the installed
  dependencies and PostgreSQL 16.2 from the `pgserver` wheel were reused, and `npm run verify` was
  exit 0 at that commit before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Two scripts ran against the local PostgreSQL 16.2 with 41 and 45 checks; all passed and each ended
with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0039` applied in order and produced thirty nine tables, thirty nine
   policies, sixty one triggers and twenty six functions.
2. **Every table shape holds.** `payments` reported 34 columns and 35 constraints, `refunds` 19 and
   18, `disputes` 21 and 20, with seven, four and four indexes, three, four and two triggers, and
   35, 20 and 22 comments, with RLS on and one policy each.
3. **No card data has a column.** A query over `information_schema.columns` for a pan, cvv, card
   number, expiry, holder or token column on `payments` returned no row, so section 18 is a property
   of the schema and not only of the adapter that will call Collect.js.
4. **A payment records its parts.** A 100.00 payment with a 3.20 processor fee and a 2.50 platform
   fee stored 10000, 320 and 250 and derived a net of 9680, with a null tail when no card was used.
5. **The amount rules hold.** A payment of nothing, a fee above the amount, a platform fee that
   overdraws the amount, a lower case currency, a method outside the vocabulary, a card tail with no
   brand, a sixteen digit tail, a brand outside the vocabulary and a status outside the vocabulary
   were each refused by name.
6. **The 3DS rule is a check.** A capture without 3DS and with only one of the two matches was
   refused, while the same capture with both matches succeeded; a capture with 3DS but no capture
   instant was refused, and a capture without 3DS and without either match was refused.
7. **A fraud signal is a failure.** A rejected payment marked captured was refused, and the same
   rejection stored as `failed` kept its code, its instant and its risk decision; a failed payment
   with no code, and a failure detail with no code, were refused.
8. **One payment per idempotency key.** The same key twice was refused by
   `payments_idempotency_key`, and the same provider transaction twice by
   `payments_provider_transaction_key`, while the same transaction identifier in test mode was a row
   of its own.
9. **Refunded money is derived.** A `refunded` status with nothing refunded and a
   `partially_refunded` status with nothing refunded were refused, and a refunded total typed in by
   hand or a refunded status typed in by hand was refused with "the refunded total of a payment is
   written by its refunds".
10. **The payment indexes answer their screens.** With sequential scans disabled the planner used
   `payments_page_idx` for the merchant list, `payments_review_idx` for the compliance queue and
   `payments_settlement_idx` for the settlement sweep, and the payment settled with its instant and
   version 2.
11. **A refund is a document.** A requested refund carried its requester and no approval, an
   approval without its instant and a requested refund carrying an approver were refused, and a
   refund of a payment that was never captured, a refund in another currency and a refund for
   another merchant were refused with their own messages.
12. **The cap holds.** A refund above the payment was refused, the same amount that would take the
   total above the payment was refused after two refunds had landed, and a platform fee returned
   above the fee taken, plus a returned amount with the flag off, were refused.
13. **The payment follows its refunds.** The first succeeded refund left 4000 and
   `partially_refunded`, the second left 9000 and the same status, and the last left 10000,
   `refunded` and its refund instant, with no writer computing any of it.
14. **A refund keeps its processor record.** A succeeded refund with no provider identifier was
   refused, a failed refund with no detail was refused, and the same processor refund identifier
   twice was refused by `refunds_provider_refund_key`.
15. **The refund queue index is used.** With sequential scans disabled the planner used
   `refunds_queue_idx` for what still needs a person.
16. **A dispute is a deadline.** It opened with 24 hours and no resolution; a window of 12 hours, a
   deadline before the opening instant, a deadline one second beyond the window and a negative
   chargeback fee were each refused by name.
17. **Evidence comes before submission.** A submission without the evidence pack was refused, the
   same dispute with the pack and a response submitted cleanly inside a 48 hour window, and the
   window could not change afterwards ("the response window is fixed once the response is
   submitted").
18. **A resolved dispute is history.** A won dispute with no outcome note was refused, the same
   update with a note succeeded and bumped the version to 2, and reopening it was refused with "a
   resolved dispute stays resolved". A dispute moved to another payment was refused, and the same
   processor dispute twice inside one merchant by `disputes_processor_key`, while another merchant
   held the same identifier as its own row.
19. **The deadline index is used.** With sequential scans disabled the planner used
   `disputes_deadline_idx` for what is still open, nearest deadline first.
20. **Row level security.** A plain role saw zero payments, zero refunds and zero disputes and could
   not write a payment or request a refund, while the owner saw its four payments, five refunds and
   two disputes.
21. **Rollback and re-apply.** The thirty nine rollbacks emptied the `public` schema completely,
   removed every function of this STEP, and the thirty nine forward files rebuilt it on a second
   database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1173 checks, 39 migrations, 39 tables, every
  forward file transactional and default-deny` (1113 after the payment table, 1083 before this
  STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0037`
  ("table payments must enable row level security in this file"), removing `company_id` from `0038`
  ("table refunds is missing the required column company_id"), inserting a `truncate` into `0039`
  ("a forward migration never drops or deletes rows") and moving `0037_payments.down.sql` away ("has
  no rollback file").
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: detaching `payments_guard_refund_state` made the payment proof report "a refunded
  total typed in by hand :: wrong reason: violates check constraint payments_refunded_status_check";
  detaching `refunds_guard_amount` made the refund proof report "a refund of a payment that was
  never captured :: the write succeeded"; detaching `refunds_sync_payment` made it report "the
  payment follows its first refund :: (0, 'captured', None)"; and detaching
  `disputes_guard_deadline` made it report "a window changed after submission :: wrong reason:
  violates check constraint disputes_due_check".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 1173 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII, checked with a byte grep for
  characters outside the printable range.

## Errors Found And Corrected In This STEP
1. **A constraint count written before it was measured.** The payment shape was planned as 36
   constraints and measured as 35, so the down file's comment was corrected with the number.
2. **A card column probe that matched the wrong column.** The query looked for column names
   containing `pan`, which matched `company_id` (com-pan-y) and reported a card column that does not
   exist. It is now a word boundary expression over the names that actually describe card data.
3. **Two seed rows that the earlier schemas required more of.** The proof's invoice needed `due_at`
   and its users needed `full_name`, both of which are required by STEP 021 and STEP 001; the seeds
   were corrected rather than the schemas.
4. **A submission instant that could not survive the outcome.** `disputes_submitted_check` required
   `submitted_at` to be set exactly while the status was `evidence_submitted`, so a dispute whose
   pack was sent and then won could not be recorded at all; the check became an implication and
   gained a companion that the submission cannot precede the opening instant, which is why the table
   has twenty constraints.
5. **A version expected one step too high.** The won dispute was expected at version 3 and measured
   2, because the refused updates before it did not bump the counter; the label was corrected.
6. **A dispute seed that relied on the wrong default.** The other merchant's row omitted `opened_at`
   and so took `now()`, which put its fixed due date outside the window and was refused by
   `disputes_due_check`; the instant is now explicit.
7. **A refund count predicted too low.** The owner count was predicted as four refunds and measured
   as five, because the refund that was only requested also belongs to the merchant.
8. **A sentence in an earlier handoff that named the wrong owner.** STEP 021 said the invoice's
   `amount_paid_minor` is written by this STEP. This STEP deliberately does not write it, because
   the ledger of STEP 025 is the single owner of money aggregation and two writers would be two
   truths; the sentence is corrected rather than the design.

## Decisions And Limits Left For Later STEPs
- **The invoice paid total is not written here.** `invoices.amount_paid_minor` and its
  `partially_paid` and `paid` states belong to the ledger posting that STEP 025 proves, so the
  payment row and the invoice row are not kept in step by this schema. That is the one link a
  service must remember until the ledger exists.
- **No ledger posting is proved in this STEP.** MASTER_PROMPT asks every money STEP for balanced
  double-entry postings; the ledger table does not exist yet, so this STEP proves the amounts, the
  generated net and the refund cap, and STEP 025 proves that every payment, refund and chargeback
  posts a balanced pair.
- **No provider sandbox cycle ran.** MASTER_PROMPT asks a STEP that touches a provider for a sandbox
  cycle; no adapter or API call is written here, only the tables they will write, so the cycle
  belongs to the adapter STEPs of section 6.
- **A refund is capped but not sequenced.** The guard refuses a total above the payment; it does not
  decide which staff role may approve a refund, which is the permission STEP.
- **A refund row and a payment row are not frozen.** The cap and the sync keep the money and the
  refunded total right, but the amount and the status of a succeeded refund and of a captured
  payment are still writable, and rewriting the refund moves the payment total with it. Freezing
  those two lives is a later migration; the audit of STEP 001-030 records the probe.
- **A chargeback fee is a column, not a posting.** Section 18 sets it and the merchant balance
  carries it; here the row records the amount, and STEP 025 posts it.
- **The evidence pack is a flag.** The invoice, the delivery proof, the client communication and the
  terms acceptance already live in their own tables; the documents themselves arrive with the file
  storage adapter (100-105), and this STEP only records that the pack is ready.
- **The deadline is a column, not a job.** The 24 hour warnings of section 19 are the job STEPs;
  this schema only states the deadline the job reads.
- **Velocity limits and the card blacklist are not tables here.** Section 18 keeps their defaults in
  config, and their rows belong to a later STEP that owns the risk rules.
- **RLS stays default-deny** until STEP 035 grants the merchant its own payments, refunds and
  disputes and the office the whole list.

## Next Chat Notes
- Next in this category is STEP 025, the double-entry ledger. A ledger entry will name the payment,
  the refund or the dispute it posts for, and the postings of one event must balance to zero; that
  is where `invoices.amount_paid_minor` belongs too.
- A payment is captured once and its refunded total is written only by `refunds_sync_payment`. A
  service that refunds must insert the refund row and let the triggers move the payment; writing
  `refunded_minor` itself is refused.
- A refund is approved by a person: `approved_by` and `decided_at` arrive together, and a refund
  that succeeded must carry the processor's refund identifier.
- `payment.status` and `refunded_minor` must be read together: a `refunded` payment has
  `refunded_minor = amount_minor`, and a `partially_refunded` one has a positive total below it.
- A dispute cannot be submitted without `evidence_ready`, and its `response_due_at` cannot move
  beyond the window its `response_window_hours` allows; a resolved dispute is frozen for good.
- The card columns are the brand and four digits only. Any adapter that wants to store a token or a
  fingerprint needs a new migration, and the blacklist STEP is the place for the fingerprint.
