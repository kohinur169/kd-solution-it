// path: docs/handoffs/STEP_021_COMPLETED.md
# STEP 021 Completed - Handoff

## STEP
- Number and title: STEP 021 - Migration for invoices, invoice items and invoice events tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 020 (`clients`,
  `products` and `services`, which this STEP references and snapshots) and STEP 018 (the price list
  the lines are priced from). STEP 022 adds estimates and recurring schedules that convert into an
  invoice, STEP 024 adds the payments that move `amount_paid_minor`, and STEP 025 writes the ledger
  entries a payment produces. The owner asked for five sub-steps with one approval between each, and
  the plan is `docs/planning/STEP_021_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0022_invoices.sql and 0022_invoices.down.sql - the document with its client snapshot,
    its seven statuses and instants, its five money columns, the number unique per merchant, the
    derived total trigger, the paid lock, six indexes, RLS and the default-deny policy.
  - migrations/0023_invoice_items.sql and 0023_invoice_items.down.sql - the printed lines with a
    generated line total, position uniqueness, optional catalogue references, the tenant pair foreign
    key, the catalogue guard and the totals sync trigger.
  - migrations/0024_invoice_events.sql and 0024_invoice_events.down.sql - the append only timeline
    with its closed type and actor vocabularies, three indexes, RLS and policy.
  - docs/planning/STEP_021_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_021_COMPLETED.md.
- Modified:
  - migrations/README.md - three inventory rows and two new rules: an invoice is a document that
    snapshots and derives rather than copies, and a line is arithmetic defined once while a timeline
    is evidence. The numbering rule moved from 26 to 29.
  - README.md - the database section describes the invoice, its lines and its timeline, directly
    above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0021`, every
  `lib/` module, `config/`, the environment contract, estimates and recurring schedules (022),
  payments, refunds and disputes (024), the ledger (025), the PDF renderer, the invoice screens, the
  reminder job, the portal token and its tokenized link (181-190), the permissive RLS policies (035)
  and every code STEP. `package.json` is untouched because the migrations gate already covers new
  files.

## Database
- Migrations added (file names): `0022_invoices`, `0023_invoice_items` and `0024_invoice_events`,
  each with its `.down.sql`. Together they create three tables, 52 columns, 52 constraints, thirteen
  indexes, 55 comments, five functions and six triggers. The schema now holds twenty four tables,
  twenty four policies, twenty nine triggers and nine functions in `public`.
- Shape per table: `invoices` 24 columns, 26 constraints, six indexes, 25 comments;
  `invoice_items` 16 columns, 15 constraints, four indexes, 17 comments; `invoice_events` 12 columns,
  11 constraints, three indexes, 13 comments.
- Money is `bigint` minor units with an explicit currency on the invoice; the line carries a decimal
  quantity and integer money, and its total is a generated column, so no float and no rounding rule
  outside the database exists.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All twenty four
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported 0
  public tables, 0 policies, 0 triggers and 0 functions in `public`, and the twenty four forward files
  applied again to a second empty database, recreating exactly twenty four tables, twenty four
  policies, twenty nine triggers and nine functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic client names, street
  addresses, prices and invoice numbers in throwaway local databases, and no real person, card, token
  or provider value was written anywhere.
- The sandbox reset the working tree and `/tmp` between sessions before this STEP started. The branch
  was restored from `origin/arena/aa2e219d-kd-solution-it` at `0365d62`, Node.js 26.13.0 was
  reinstalled from the npm registry package `node-linux-x64@26.13.0`, dependencies were installed, and
  PostgreSQL 16.2 was started again from the `pgserver` wheel. `npm run verify` was exit 0 at that
  commit before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three scripts ran against the local PostgreSQL 16.2 with 48, 39 and 30 checks; all passed and each
ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0024` applied in order and produced twenty four tables, twenty four
   policies, twenty nine triggers and nine functions.
2. **Every table shape holds.** `invoices` reported 24 columns and 26 constraints, `invoice_items` 16
   and 15, `invoice_events` 12 and 11, with six, four and three indexes, RLS on, one policy each, and
   25, 17 and 13 comments, so every column is documented.
3. **A draft is numbered by nothing.** A new invoice stored as `draft` with no number, no issue
   instant, no money and version 1.
4. **A wrong total is derived, not stored.** A row written with `total_minor = 5` and a subtotal of
   100.00 less a 10.00 discount plus 8.00 tax was stored as 98.00 by `invoices_derive_total`.
5. **The status vocabulary is section 16's**, asserted from `pg_get_constraintdef`, and an unknown
   word was refused by the vocabulary or the issue check, whichever the planner reached first.
6. **The status carries its own facts.** A draft carrying a number, a sent invoice without one, a
   lower case number, a lower case currency, a discount above the subtotal, a negative tax line, a
   draft holding money, a paid status without its instant, a paid status short of its total, a
   partial payment of 19.99, a partial payment equal to the total, a void status without its instant,
   a due instant before the issue instant, a first view before issue, a padded and an empty client
   name, an address without an at sign, a 601 character address snapshot and a 2001 character memo
   were each refused by name.
7. **Numbers are per merchant.** The second merchant issued `INV-2026-0001` independently, and a
   duplicate inside one merchant was refused by `invoices_number_key`.
8. **The 20 USD floor holds.** A 20.00 partial payment of a 50.00 invoice was accepted and left a
   balance, while 19.99 was refused by `invoices_partial_minimum_check`.
9. **A paid invoice is locked.** An edit to its memo, a soft delete and a return to `void` were each
   refused with "a paid invoice is locked".
10. **The workflow moves.** A draft became `sent` with its number and instant, then `void` with its
    instant while keeping the number; a draft became `sent`, then `viewed`, and stayed editable while
    unpaid.
11. **The page index is used.** With sequential scans disabled the planner answered the list from
    `invoices_page_idx`.
12. **A line rounds once.** Two and a half hours at 19.99 less a 5.00 discount is 44.98, and the
    generated column reports version 1 on the first write.
13. **The invoice totals itself.** Two lines settled the subtotal at 791.98 before any invoice level
    discount, then a 10.00 discount and 8.00 tax produced a total of 789.98 through the trigger pair.
14. **Every line shape is refused by name.** Position zero and a repeated position, a zero and a
    negative quantity, a negative unit price, a discount above the gross line, a padded and a 301
    character description, a unit outside the vocabulary, a line with both a product and a service, a
    product and a service from another merchant, a line numbered to another merchant's invoice, and a
    line moved to another invoice.
15. **An issued invoice holds its lines.** A new line, an edit and a soft delete on a sent invoice
    were each refused with "lines of an issued invoice are locked", while the same operations are
    allowed on a draft.
16. **Removing and editing lines moves the totals.** A removed line lowered the subtotal and freed
    its position, and an edited line moved its own total, its version and the invoice subtotal.
17. **The product index answers the report.** With sequential scans disabled the planner used
    `invoice_items_product_idx` for "which lines came from this product".
18. **Section 16 end to end.** Three lines gave 971.98 and 969.98, a created event and a note, then
    sending assigned `INV-2026-0001`, a client view was recorded, a 20.00 payment moved the invoice
    to `partially_paid`, and the final payment locked it as `paid`.
19. **The timeline reads in order with its actors.** created, note, sent, viewed, payment_received,
    paid, from merchant, merchant, merchant, client, client and system.
20. **The timeline is evidence.** An edit to a recorded event and a removal of one were both refused
    with "invoice events are append only".
21. **Void and duplicate.** A void invoice kept its number and its instant, and a duplicate carried
    the same three lines and the same total.
22. **The event shape is closed.** An unknown type, an unknown actor, a system event naming a person,
    a 501 character detail, a padded detail and an event on another merchant's invoice were refused.
23. **The timeline index is used.** With sequential scans disabled the planner used
    `invoice_events_timeline_idx`.
24. **Row level security.** A plain role saw zero invoices, zero lines and zero events and could not
    insert into any of them, while the owner saw its own five invoices, four lines and eight events.
25. **Rollback and re-apply.** The twenty four rollbacks emptied the `public` schema completely,
    removed every function of this STEP, and the twenty four forward files rebuilt it on a second
    database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 723 checks, 24 migrations, 24 tables, every
  forward file transactional and default-deny` (663 after the invoice table, 693 after the lines;
  633 before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0022`
  ("table invoices must enable row level security in this file"), removing `company_id` from `0023`
  ("table invoice_items is missing the required column company_id"), inserting a `truncate` into
  `0024` ("a forward migration never drops or deletes rows") and moving `0023_invoice_items.down.sql`
  away ("has no rollback file").
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: detaching `invoices_guard_paid` made the invoice proof report "an edit to a paid invoice
  :: the write succeeded"; detaching `invoice_items_sync_totals` made the line proof report "the
  invoice subtotal follows the lines before any invoice level discount :: (0,)"; and detaching
  `invoice_events_guard_append_only` made the cross-table proof report both an event edit and a
  removal that succeeded.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 723 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII (checked with
  `grep -c '[^ -~]'`).

## Errors Found And Corrected In This STEP
1. **A check that masked the rule it guarded.** `invoice_items_line_total_check` fired before the
   quantity and price checks, so a negative quantity or price was reported as a bad total; the check
   was removed because the generated total cannot go negative once its three inputs are valid.
2. **A comparison that hid two other checks.** The discount check compared against a possibly
   negative gross line, which made a negative price indistinguishable from an oversized discount; it
   now floors the gross at zero with `greatest(..., 0)`, so each rule fails under its own name.
3. **A discount larger than an empty subtotal.** The proof first created a draft with a 10.00
   discount and no lines, which `invoices_discount_check` refused; the scenario now adds the lines
   first and then sets the invoice level discount and tax, which is also the real order of use.
4. **A duplicate that carried a number while still a draft.** The duplicate invoice was created as
   `draft` with a number and an issue instant, which `invoices_issue_check` refused; a duplicate now
   starts as an unnumbered draft, exactly like a new invoice.
5. **Two probes that never reached their constraint.** An unknown status was refused by the issue
   check before the vocabulary check, so the proof now asserts the vocabulary from the catalog and
   accepts either refusal; and event probes passing a null instant hit the not null before the check
   they aimed at, so the helper now coalesces the instant to `now()`.
6. **Counts written before they were measured.** The owner counts for lines and events were written
   as three and seven and measured as four and eight, because a soft deleted line and a duplicated
   invoice also belong to the merchant; the labels were corrected with the numbers.

## Decisions And Limits Left For Later STEPs
- The invoice stores no token. The tokenized link of section 16 is the portal STEP's data
  (181-190), and rule 14 of the migrations folder still applies: a token is stored as a hash, never
  as the token.
- `amount_paid_minor` is a running total written by the payment STEP (024). This STEP proves the
  states it can be in and the 20 USD floor they imply; it does not write a payment row.
- The invoice level `tax_minor` is the section 7 tax line. The TaxCloud STEP writes it; nothing here
  computes tax.
- Transition legality beyond what a check can see (for example sent then viewed then overdue) is the
  service's rule. The schema fixes the vocabulary, the instants and the money, and refuses anything
  contradictory, but it does not demand that every status was reached by the shortest path.
- A catalogue reference is verified by a trigger rather than a composite foreign key, because adding
  a unique key to `products` or `services` would mean editing a migration from STEP 020. A later STEP
  that adds such a key can replace the trigger and keep the same behaviour.
- `invoice_events` is append only, so a wrong note is corrected by writing another event, never by
  editing the first. The service that records events owns that discipline.
- RLS stays default-deny until STEP 035 grants the merchant its own invoices, lines and events and
  the office the whole list.

## Next Chat Notes
- Next in this category is STEP 022 (estimates, estimate signatures and recurring schedules). An
  accepted estimate converts into an invoice, so it will insert here with `status = 'draft'` and no
  number, and the recurring schedule will write the same shape on a timer.
- Totals are maintained by triggers. A writer that inserts lines and then sets `discount_minor` and
  `tax_minor` in the same transaction gets a correct total without computing anything itself; a
  writer that sets the totals by hand will be overruled, which is deliberate.
- Lines may only change while the invoice is `draft`. The service that edits a sent invoice must
  void and reissue, or add a credit note in a later STEP, rather than edit a document a client holds.
- `paid` cannot be reached with a short amount, and a paid invoice cannot be edited at all. Refunds
  and chargebacks are payment facts (STEP 024) and leave the invoice as it was.
- The partial payment floor is expressed in minor units of USD. A non USD invoice only has to carry a
  positive partial amount; a second currency is a decision for a later STEP, not a silent change.
