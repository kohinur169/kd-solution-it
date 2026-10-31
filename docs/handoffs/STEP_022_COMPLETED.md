// path: docs/handoffs/STEP_022_COMPLETED.md
# STEP 022 Completed - Handoff

## STEP
- Number and title: STEP 022 - Migration for estimates, estimate signatures and recurring schedules
  tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 021 (`invoices`,
  `invoice_items` and `invoice_events`, which an accepted quote becomes and which a recurring
  schedule uses as its template), STEP 020 (`clients`, `products`, `services`, snapshotted and
  referenced here) and STEP 018 (the price list the quoted lines are priced from). STEP 023 adds the
  expenses, STEP 024 the payments a converted invoice eventually collects, and STEP 035 the
  permissive policies. The owner asked for five sub-steps with one approval between each, and the
  plan is `docs/planning/STEP_022_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0025_estimates.sql and 0025_estimates.down.sql - the quote as a document: its client
    snapshot, its five statuses and the void reason, its expiry, its five money columns and the
    derived total trigger that reuses `public.invoices_derive_total()`, the number unique per
    merchant, the terminal lock, the one conversion link into an invoice, seven indexes, RLS and the
    default-deny policy.
  - migrations/0026_estimate_items.sql and 0026_estimate_items.down.sql - the quoted lines with a
    generated line total, position uniqueness per quote, optional catalogue references, the tenant
    pair foreign key, the catalogue guard and the totals sync trigger.
  - migrations/0027_estimate_signatures.sql and 0027_estimate_signatures.down.sql - the signature
    evidence with its consent wording and forced-true flag, its instant, IP, geo, device fingerprint
    and 64 character document hash, one row per quote, the open-quote guard, the append only guard,
    three indexes, RLS and the policy.
  - migrations/0028_recurring_schedules.sql and 0028_recurring_schedules.down.sql - the repeating
    invoice with its draft template, its interval and count, its run dates, its due offset, its
    reminder pair, the template guard, four indexes, RLS and the default-deny policy.
  - docs/planning/STEP_022_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_022_COMPLETED.md.
- Modified:
  - migrations/README.md - four inventory rows and two new rules: a quote is a document that ends in
    a decision, and a signature is evidence while a schedule is a promise. The numbering rule moved
    from 29 to 32.
  - README.md - the database section describes the quote, its signature and the repeating invoice,
    directly above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0024`, every
  `lib/` module, `config/`, the environment contract, payments, refunds and disputes (024), the
  ledger (025), the PDF renderer, the estimate screens, the signature capture UI, the recurring and
  reminder job, the portal token and its tokenized link (181-190), the permissive RLS policies (035)
  and every code STEP. `package.json` is untouched because the migrations gate already covers new
  files.

## Database
- Migrations added (file names): `0025_estimates`, `0026_estimate_items`, `0027_estimate_signatures`
  and `0028_recurring_schedules`, each with its `.down.sql`. Together they create four tables, 79
  columns, 76 constraints, eighteen indexes, 83 comments, six functions and ten triggers. The schema
  now holds twenty eight tables, twenty eight policies, thirty nine triggers and fifteen functions
  in `public`.
- Shape per table: `estimates` 24 columns, 26 constraints, seven indexes, 25 comments, three
  triggers; `estimate_items` 16 columns, 15 constraints, four indexes, 17 comments, three triggers;
  `estimate_signatures` 18 columns, 15 constraints, three indexes, 19 comments, two triggers;
  `recurring_schedules` 21 columns, 20 constraints, four indexes, 22 comments, two triggers.
- Money is `bigint` minor units with an explicit currency, copied from the invoice shape: the same
  `subtotal`, `discount`, `tax` and `total` columns, the same shared derive function, no paid
  amount, because a quote does not take money. The line carries a decimal quantity and integer
  money, and its total is a generated column, so the quote and the invoice it becomes cannot
  disagree about arithmetic.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All twenty eight
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the twenty eight forward
  files applied again to a second empty database, recreating exactly twenty eight tables, twenty
  eight policies, thirty nine triggers and fifteen functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic client names, street
  addresses, prices, quote numbers and a made up signature fingerprint in throwaway local databases,
  and no real person, card, token, provider value or private key was written anywhere.
- The working tree and `/tmp` survived from STEP 021; Node.js 26.13.0, the installed dependencies
  and PostgreSQL 16.2 from the `pgserver` wheel were reused, and `npm run verify` was exit 0 at
  commit `28696f9` before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three scripts ran against the local PostgreSQL 16.2 with 43, 39 and 46 checks; all passed and each
ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0028` applied in order and produced twenty eight tables, twenty
   eight policies, thirty nine triggers and fifteen functions.
2. **Every table shape holds.** `estimates` reported 24 columns and 26 constraints, `estimate_items`
   16 and 15, `estimate_signatures` 18 and 15, `recurring_schedules` 21 and 20, with seven, four,
   three and four indexes, RLS on, one policy each, and 25, 17, 19 and 22 comments, so every column
   is documented.
3. **A quote is a draft by default.** A new quote stored as `draft` with no number, no issue
   instant, no expiry instant visible to the client, no money and version 1.
4. **A wrong total is derived, not stored.** A row written with `total_minor = 5` and a subtotal of
   100.00 less a 10.00 discount plus 8.00 tax was stored as 98.00 by the shared
   `invoices_derive_total()` function, so a quote and an invoice total by the same rule.
5. **The status vocabulary is section 16's**, asserted from `pg_get_constraintdef`, and an unknown
   word was refused by the vocabulary or the issue check, whichever the planner reached first.
6. **A quote states its own end.** `expires_at` is not null and must follow `issued_at`, and
   `void_reason` is `declined`, `expired` or `withdrawn`, present exactly when the status is `void`,
   so section 16's folded decline and expiry stay distinguishable.
7. **The status carries its own facts.** A void status without a reason, a reason on an open quote,
   the word `cancelled`, a draft carrying a number, a sent quote without one, a lower case number,
   an expiry before the issue instant, an accepted status without its instant, a conversion link on
   a quote that was not accepted, a padded and an empty client name, an address without an at sign,
   a 2001 character memo and a lower case currency were each refused by name.
8. **Numbers are per merchant.** Two merchants issued `EST-2026-0001` independently, and a duplicate
   inside one merchant was refused by `estimates_number_key`.
9. **The workflow moves.** A draft became `sent` with its number and instant, then `viewed`, then
   `accepted`; a declined quote and an expired quote both became `void` carrying `declined` and
   `expired` respectively.
10. **A decided quote is locked.** An edit to the memo of an accepted quote, a return to `void` and
   a soft delete were each refused with "a decided estimate is locked".
11. **One quote produces one invoice.** A second quote converting into the same invoice was refused
   by `estimates_invoice_key`, and because the terminal guard freezes a decided row, acceptance and
   `converted_invoice_id` are written in one statement, which the service must also do.
12. **The expiry index is used.** With sequential scans disabled the planner answered "which open
   quotes expire soon" from `estimates_expiry_idx`.
13. **A line rounds once.** Two and a half hours at 1999 less a 500 discount is 4498 minor units,
   and the generated column reports version 1 on the first write.
14. **The quote totals itself.** Two lines settled the subtotal at 79198 before any quote level
   discount, then a 1000 discount and 800 tax produced a total of 78998 through the trigger pair.
15. **Every line shape is refused by name.** Position zero and a repeated position, a zero and a
   negative quantity, a negative unit price, a discount above the gross line, a padded and a 301
   character description, a unit outside the vocabulary, a line with both a product and a service, a
   product and a service from another merchant, a line numbered to another merchant's quote, and a
   line moved to another quote.
16. **An issued quote holds its lines.** A new line, an edit and a soft delete on a sent quote were
   each refused with "lines of an issued estimate are locked", while the same operations are allowed
   on a draft.
17. **Removing and editing lines moves the totals.** A removed line lowered the subtotal and freed
   its position, and an edited line moved its own total, its version to 2 and the quote subtotal to
   31896.
18. **Every section 16 element is stored.** The signature row held the decision, the consent wording
   with `consent_accepted = true`, a 64 character lower case hash, `host(ip)` equal to
   `203.0.113.10`, the geo location and the device fingerprint.
19. **The signature shape is closed.** An unticked consent, the word `maybe`, an upper case hash, a
   short hash, a three character fingerprint and an address without an at sign were refused.
20. **One signature per quote, and it is evidence.** A second signature was refused, an edit to a
   recorded signature and a removal of one were both refused with "estimate signatures are append
   only", and a signature offered on a draft or on a void quote was refused with "a quote accepts a
   signature only while it is open".
21. **Section 16 end to end.** An accepted two line quote converted into an invoice carrying the
   same two lines and the same total of 79198, while a declined quote stayed `void` with its
   signature on file as the evidence a chargeback would read.
22. **A schedule is a promise.** The template had to be a draft invoice of the same merchant and the
   same client, a duplicate template was refused by `recurring_schedules_template_key`, and
   `fortnight`, a count of 0, a next run before the start, an end before the start, terms of 366
   days, a reminder interval without a limit and a reminder before any run were each refused by
   name.
23. **The schedule moves.** A schedule paused, returned to active and ended, each with its instant,
   and the planner answered the due list from `recurring_schedules_run_idx`.
24. **Nothing here retries.** A query over `information_schema.columns` for a retry or attempt
   column returned no row, because section 16 says a failed recurring payment is not retried
   automatically; the absence is structural, not a setting.
25. **Row level security.** A plain role saw zero quotes, zero lines, zero signatures and zero
   schedules and could not insert into any of them, while the owner saw its own six quotes, two
   signatures and one schedule.
26. **Rollback and re-apply.** The twenty eight rollbacks emptied the `public` schema completely,
   removed every function of this STEP, and the twenty eight forward files rebuilt it on a second
   database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 843 checks, 28 migrations, 28 tables, every
  forward file transactional and default-deny` (753 after the quote table, 783 after the lines, 723
  before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0025`
  ("table estimates must enable row level security in this file"), removing `company_id` from `0026`
  ("table estimate_items is missing the required column company_id"), inserting a `truncate table
  public.estimate_signatures;` into `0027` ("a forward migration never drops or deletes rows") and
  moving `0028_recurring_schedules.down.sql` away ("has no rollback file").
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: detaching `estimates_guard_terminal` made the cross-table proof report "an edit to the
  accepted quote after conversion :: the write succeeded"; detaching
  `estimate_signatures_guard_append_only` made it report both "an edit to a recorded signature ::
  the write succeeded" and "a removal of a recorded signature :: the delete succeeded"; and
  detaching `recurring_schedules_guard_template` made it report "a template that is not a draft ::
  the write succeeded" and "a template from another merchant :: the write succeeded".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 843 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII (checked with `grep -c '[^
  -~]'`).

## Errors Found And Corrected In This STEP
1. **Counts written before they were measured.** The quote shape was planned as 25 constraints and
measured as 26, so the down file's comment was corrected; the owner counts for the rebuilt database
were planned as five and measured as six. The same discipline as STEP 020 and 021: the catalog is
measured first, then the label is written.
2. **A neighbouring check that hijacked a proof.** An unknown status was refused by
`estimates_issue_check` before the vocabulary check, so the proof now asserts the five word
vocabulary from `pg_get_constraintdef` and accepts either refusal, instead of adding a summary check
that would have masked the specific ones.
3. **A duplicate probe that ran too late.** The second signature was first attempted after
acceptance and was refused by the terminal guard instead of the unique index; it now runs while the
quote is still open, which is the only state in which a signature can be written at all.
4. **A conversion that the lock pre-empted.** Creating the invoice and then setting
`converted_invoice_id` in a second statement failed with "a decided estimate is locked"; the
acceptance and the link are now one statement, and the handoff says so for the service author.
5. **A draft invoice that could not carry its own numbers.** The conversion invoice was first
created with `issued_at`, then with a discount and tax before its lines existed, and
`invoices_issue_check` and `invoices_discount_check` refused both; it is now created bare, given the
copied lines, and only then the quote level discount and tax, which is also how the invoice STEP
proved it.
6. **An address that rendered a netmask.** `ip::text` returns `203.0.113.10/32`, so the proof now
compares `host(ip)`; the column and its check were already right.
7. **A refusal that arrived as a privilege error.** A non-owner role inserting a signature failed
with "permission denied for table estimates" before RLS, because the decision guard reads the quote;
the proof accepts any of the three refusal messages, and the append only guarantee itself was proven
by detaching the guard and watching the edit and the removal succeed.

## Decisions And Limits Left For Later STEPs
- The quote stores no token. The tokenized link of section 16 is the portal STEP's data (181-190),
  and rule 14 of the migrations folder still applies: a token is stored as a hash, never as the
  token.
- Acceptance produces the invoice row only; the payment link of section 16 belongs to the payments
  and portal STEPs. The quote therefore has no money collection column at all.
- `estimate_signatures` stores `signature_path`, a pointer, not a drawing. The file storage adapter
  arrives in STEP 100-105, and the signature capture UI with it.
- The signature is evidence of the document as it stood: `document_hash` is the SHA-256 the client
  saw. Producing that hash is the PDF renderer's job, not the database's.
- `recurring_schedules` is a promise, not a job. Which worker wakes up, how it orders the due list
  and how it records a failure is STEP 023's reminder work and the job STEPs; this schema only fixes
  the interval, the run dates and the reminder policy.
- Section 16 says no automatic retry, so no retry or attempt column exists and none should be added
  quietly. If a later STEP wants to record a failure, it writes it as an event on the invoice, not
  as a counter that invites a retry loop.
- The template is a draft invoice, so a merchant edits its lines and its terms with the invoice
  editor it already has. A dedicated template table was rejected because it would be a second
  catalogue of lines to keep in step.
- RLS stays default-deny until STEP 035 grants the merchant its own quotes, signatures and schedules
  and the office the whole list.

## Next Chat Notes
- Next in this category is STEP 023. The quote, its lines, its signature and the schedule are the
  four pieces section 16 asks for, and the invoice they produce is STEP 021's shape unchanged.
- A writer that accepts a quote must do it in one statement: `status`, `accepted_at` and
  `converted_invoice_id` together, because the terminal guard freezes the row the moment it is
  decided. The service that also inserts the invoice should do both in one transaction.
- Totals are maintained by triggers on both the quote and its lines. A writer that sets the totals
  by hand will be overruled, which is deliberate and matches the invoice.
- Lines may only change while the quote is `draft`. Once it is issued the guard refuses a new line,
  an edit and a removal, so a correction is a new quote, exactly as an issued invoice is corrected
  by voiding and reissuing.
- The signature can be written only while the quote is `sent` or `viewed`, and never updated. A
  declined quote keeps its signature as the evidence that the client saw the document and said no.
- A schedule may only wake from `active`, must have a `next_run_on`, and its reminder pair is either
  both zero or both set. A paused or ended schedule states its instant; an active one does not.
