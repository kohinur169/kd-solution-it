// path: docs/handoffs/STEP_026_COMPLETED.md
# STEP 026 Completed - Handoff

## STEP
- Number and title: STEP 026 - Migration for settlements, holds, reserves and payouts tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 025 (the ledger these
  four tables post to and the `reserve_held` account), STEP 024 (the payments a hold pins and a
  settlement collects), STEP 023 (the provider batch a settlement comes from) and STEP 022 (the
  invoices behind the payments). STEP 027 adds the payout bank accounts and the bank change requests
  this STEP's payouts name only as a snapshot, and STEP 035 the permissive policies. The owner asked
  for three sub-steps with one approval between each, and the plan is
  `docs/planning/STEP_026_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0042_settlements.sql and 0042_settlements.down.sql - the processor batch with its
    window, its six money parts, the generated net that may be negative, the hold days copied onto
    the row, the release instant, the four statuses and the identity guard.
  - migrations/0043_holds.sql and 0043_holds.down.sql - money the platform keeps back, with its five
    reasons, the payment and batch links, the cap guard, the owner guard and the released and
    collected pairs.
  - migrations/0044_reserves.sql and 0044_reserves.down.sql - the rolling reserve in basis points
    with its release days, the held and released totals and one active reserve per merchant.
  - migrations/0045_payouts.sql and 0045_payouts.down.sql - the payout request with its requester,
    its approver, the 100 USD minimum and its remainder exception, the destination snapshot and the
    failure pair.
  - docs/planning/STEP_026_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_026_COMPLETED.md.
- Modified:
  - migrations/README.md - four inventory rows for `0042` to `0045` and two new rules: a settlement
    is a batch and a hold is money kept back, and a reserve is one account while a payout is a
    request with a decision. The numbering rule moved from 36 to 38 and the introduction now says
    forty five files.
  - README.md - the database section describes the settlement, the hold, the reserve and the payout,
    directly above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0041`, every
  `lib/` module, `config/`, the environment contract, the payout bank accounts and bank change
  requests (027), the settlement statement screens and CSV export, the release job, the
  reconciliation job, the permissive RLS policies (035) and every code STEP. `package.json` is
  untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0042_settlements`, `0043_holds`, `0044_reserves` and
  `0045_payouts`, each with its `.down.sql`. Together they create four tables, 84 columns, 83
  constraints, sixteen indexes, 88 comments, six functions and ten triggers. The schema now holds
  forty five tables, forty five policies, seventy eight triggers and thirty eight functions in
  `public`.
- Shape per table: `settlements` 23 columns, 18 constraints, five indexes, 24 comments, two
  triggers; `holds` 19 columns, 21 constraints, four indexes, 20 comments, four triggers;
  `reserves` 16 columns, 14 constraints, three indexes, 17 comments, two triggers; `payouts` 26
  columns, 30 constraints, four indexes, 27 comments, two triggers.
- Money is `bigint` minor units beside a three letter currency, as every money table since STEP 018.
  `settlements.net_minor` and `payouts.net_minor` are generated columns, so neither can disagree
  with the parts printed beside it, and every one of the four tables is the source row of a ledger
  source type that STEP 025 already accepts: `settlement`, `hold`, `reserve` and `payout`.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All forty five
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the forty five forward
  files applied again to a second empty database, recreating exactly forty five tables, forty five
  policies, seventy eight triggers and thirty eight functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic batch identifiers, a
  synthetic bank name, a four character account tail, a synthetic country and a synthetic provider
  payout identifier in throwaway local databases, and no real bank, card or provider value was
  written anywhere.
- The working tree survived from STEP 025 at commit `81de8c0`; Node.js 26.13.0, the installed
  dependencies and PostgreSQL 16.2 from the `pgserver` wheel were reused, and `npm run verify` was
  exit 0 at that commit before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Two scripts ran against the local PostgreSQL 16.2 with 54 and 52 checks; all passed and each ended
with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0045` applied in order and produced forty five tables, forty five
   policies, seventy eight triggers and thirty eight functions.
2. **Every table shape holds.** `settlements` reported 23 columns and 18 constraints, `holds` 19 and
   21, `reserves` 16 and 14 and `payouts` 26 and 30, with five, four, three and four indexes, two,
   four, two and two triggers, and 24, 20, 17 and 27 comments, with RLS on and one policy each.
3. **A settlement derives its net.** A batch of 100000 with 4000 refunds, 5000 chargebacks, 2900
   processor fee, 2500 platform fee and 10000 reserve stored 75600, with its status, its three hold
   days and a release instant after the window end.
4. **A negative net is legal.** A batch whose chargebacks outgrew its gross stored -4000, because
   section 10 covers a negative balance from the reserve first.
5. **The batch rules are checks.** A gross of zero, a window that ends where it starts, a release
   before the window end, a 61 day hold, a negative deduction, a batch identifier with a space, a
   lower case currency, a status outside the four, a settled batch with no instant, a failed batch
   with no detail and a padded failure detail were each refused by name.
6. **One batch per merchant.** The same processor identifier twice for one merchant was refused by
   `settlements_provider_key` and the same identifier became a row of its own for another merchant.
7. **A batch is frozen.** Moving it to another merchant, moving the window and changing the hold
   days were refused, an unsettled batch still moved from pending to in transit with version 2, it
   settled with its instant at version 3, and a settled batch rewritten was refused with "a settled
   or failed settlement is history".
8. **The settlement indexes answer their screens.** With sequential scans disabled the planner used
   `settlements_release_idx` for the release sweep and `settlements_page_idx` for the merchant list.
9. **A hold is capped by its payment.** 3000 and then 7000 against a 10000 payment were allowed, a
   third hold of one minor unit was refused with "a hold cannot take more than its payment", and
   raising the first hold above the payment was refused the same way.
10. **A hold belongs to one merchant.** A hold on another merchant's payment was refused by the
    owner guard and a hold naming another merchant's batch was refused by `holds_settlement_fkey`.
11. **The hold vocabulary holds.** A hold of nothing, a reason outside the five, a release before
    the placement, a released hold with no instant, one with no person and a collected hold with no
    note were each refused by name.
12. **A hold closes one way.** A released hold carried its instant and its person, a collected hold
    carried its note, a closed hold rewritten was refused with "a closed hold is history", and an
    active hold could be annotated with version 2.
13. **The hold queue index is used.** With sequential scans disabled the planner used
    `holds_open_idx` for what is still held and due.
14. **A reserve holds its terms.** A reserve opened at 500 basis points for 90 days, a second active
    reserve for the same merchant was refused by `reserves_active_key`, the first paused with its
    note at version 2 and a fresh active one then opened.
15. **The reserve rules are checks.** A percent above 10000, a release window of no days, a released
    total above the held total, a closed reserve with no instant, a release before the start and a
    negative held total were each refused by name.
16. **A reserve is frozen.** A changed percent was refused, closing with its instant succeeded, and
    a closed reserve rewritten was refused with "a closed reserve is history".
17. **The reserve release job uses its index.** With sequential scans disabled the planner used
    `reserves_release_idx`.
18. **A payout derives its net.** 20000 with a 500 fee stored 19500 and status requested with no
    approver.
19. **The minimum has one exception.** 5000 without the remainder flag was refused by
    `payouts_minimum_check`, the same 5000 with the flag was allowed, 20000 with the flag was
    refused by `payouts_remainder_check`, and a fee above the amount and a negative fee were
    refused.
20. **A payout needs its decision.** Processing with no approver, an approver with no approval
    instant, a paid payout with no paid instant, one with no processing instant, one with no
    destination, a failed payout with no code and a detail with no code were each refused by name.
21. **The destination is a complete snapshot.** Half a destination, a five character tail and a
    lower case country were each refused, and a payout on another merchant's batch was refused by
    `payouts_settlement_fkey`.
22. **The payout walks its states.** It moved requested, approved, processing and paid at version 4
    with its provider identifier and its destination, a paid payout rewrote neither its amount nor
    its note, a payout changed to another currency was refused, and the same provider identifier
    twice for one merchant was refused by `payouts_provider_key` while another merchant kept its
    own.
23. **The payout indexes answer their screens.** With sequential scans disabled the planner used
    `payouts_queue_idx` for what still needs a person and `payouts_page_idx` for the merchant
    list.
24. **The ledger accepts the new source rows.** A balanced pair with source type `reserve` and the
    reserve row as its `source_id` committed through the deferred balance trigger of STEP 025.
25. **Row level security.** A plain role saw no batch, no hold, no reserve and no payout and could
    not book a batch or request a payout, while the owner saw its two batches, four holds, two
    reserves and two payouts.
26. **Rollback and re-apply.** The forty five rollbacks emptied the `public` schema completely,
    removed every function, and the forty five forward files rebuilt it on a second database with no
    rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1353 checks, 45 migrations, 45 tables, every
  forward file transactional and default-deny` (1293 after the hold, 1233 before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0042`
  and from `0044`, renaming the policy in `0043` and in `0045`, removing the closing `commit;` from
  `0043` and from `0045`, and removing the `company_id` column from `0042` and the `version` column
  from `0044`, each refused by the sentence the gate names.
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: detaching `settlements_guard_state` made the proof report the three frozen identity
  labels and the version label; detaching `holds_guard_amount` made it report the cap labels and the
  owner count; detaching `holds_guard_owner` made it report the other merchant label; detaching
  `reserves_guard_state` made it report the percent label, the close label and the closed label; and
  detaching `payouts_guard_state` made it report the amount, the note and the currency labels.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 1353 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII, checked with a byte grep for
  characters outside the printable range.

## Errors Found And Corrected In This STEP
1. **An owner count that counted every row.** The settlement probe asked for the total of the table
   rather than the merchant's rows and expected two where three existed, because another merchant's
   batch was in the same database. The query now filters by the merchant, which is also what the
   label says.
2. **A trigger order that decided which refusal a probe sees.** `holds_guard_amount` runs before
   `holds_guard_state`, so raising a hold above its payment is refused by the cap and not by the
   frozen identity; and on a paid payout the identity guard pre-empts the closed lock, so the amount
   rewrite of a paid payout reports the identity sentence. The probes now expect the guard that
   actually runs and a note rewrite proves the closed lock, rather than a merged check that would
   mask both.
3. **A rollback comment that claimed a foreign key that does not exist.** The settlement rollback
   first said a reserve names the batches it withheld from; the reserve reaches a batch only through
   the ledger, so the sentence now says that.
4. **A date comparison that would have made a check unstable.** The reserve's next release was first
   planned as a `date` compared to a timestamp through a time zone conversion; it is a `timestamptz`
   column with a plain comparison, so the check stays immutable and no time zone can move it.
5. **A shape count that had to be measured, not planned.** The four tables were measured after they
   applied (23, 19, 16 and 26 columns; 18, 21, 14 and 30 constraints) and the proof asserts those
   numbers, because every STEP since 020 was off by one where a count was written first.

## Decisions And Limits Left For Later STEPs
- **The payout destination is a snapshot.** STEP 027 owns the bank account table and the 96 hour
  cooling period, so a payout records the bank name, the last four and the country as text. STEP 027
  adds the foreign key column to `payouts` when its table exists; a dangling uuid without a table
  would have been worse than the snapshot an audit needs anyway.
- **No settlement line table.** A batch is one row of totals. If a later STEP needs per payment
  settlement detail, it can derive it from `payments` by window, or add a line table with its own
  proof; nothing here stores the same money twice.
- **The release job is code.** `release_due_at`, `next_release_on` and their indexes are what the
  job of section 10 reads; no job runs yet, and no scheduler is implied by these columns.
- **A payout is not capped against the settlement.** The schema checks the minimum, the fee and the
  identity; whether a merchant may be paid more than its settled balance is a rule of the payout
  service and of the ledger balance, which is a sum and not a column.
- **The cooling period and the bank change requests are STEP 027.** Section 10 pauses every payout
  during the 96 hours after a verified bank change; nothing here knows about that pause because the
  bank change table does not exist yet.
- **The failed payout email is not sent here.** The row carries the code and the detail the email
  needs; sending belongs to the notification STEP.
- **The hold days, the reserve percent and the payout minimum are settings.** They reach these rows
  as values, copied where history matters (the hold days) and stored where the agreement lives (the
  reserve percent); the config STEP owns the settings themselves.
- **RLS stays default-deny** until STEP 035 grants the merchant its own batches, holds, reserves and
  payouts and the office the whole list.

## Next Chat Notes
- Next in this category is STEP 027, the payout bank accounts and the bank change requests. It adds
  the verified account table, the 96 hour cooling period and the `payouts` foreign key column this
  STEP left as a snapshot.
- A settlement's net may be negative. A reader must not treat a negative `net_minor` as corruption;
  it is the reserve's job to cover it, and the ledger carries the reserve movement.
- A hold never exceeds its payment and never moves once released or collected. To hold more of the
  same payment, place a second hold while the payment has room; to correct a hold, close it and
  place another.
- A reserve is one active row per merchant. Pausing it frees the slot for a new agreement and keeps
  the old row as history.
- A payout cannot be processed or paid without an approver, and a paid payout must name its
  destination snapshot. Anything below 10000 minor units must be flagged as the accumulated
  remainder.
- Every one of these four rows posts to the ledger through its own `source_id`; the posting service
  is a later STEP and the source types already exist in `ledger_entries`.
