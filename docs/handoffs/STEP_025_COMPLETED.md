// path: docs/handoffs/STEP_025_COMPLETED.md
# STEP 025 Completed - Handoff

## STEP
- Number and title: STEP 025 - Migration for double-entry ledger accounts and ledger entries tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 024 (the payments,
  refunds and disputes an entry posts for), STEP 023 (the providers behind a payment), STEP 022 (the
  invoices a payment settles) and STEP 021 (the invoice states and the paid lock). STEP 026 adds the
  settlements, holds, reserves and payouts that will post against this ledger, and STEP 035 the
  permissive policies. The owner asked for three sub-steps with one approval between each, and the
  plan is `docs/planning/STEP_025_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0040_ledger_accounts.sql and 0040_ledger_accounts.down.sql - the chart of accounts
    with its eight closed codes, its kind and side pairing, its platform and merchant scopes, its
    close instant, its identity guard and its row metadata trigger.
  - migrations/0041_ledger_entries.sql and 0041_ledger_entries.down.sql - the double-entry rows
    with their balanced group, the deferred balance constraint trigger, the append only guard, the
    reversal mirror and its one-reversal key, the three source pairs, the account guard and the
    invoice sync.
  - docs/planning/STEP_025_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_025_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows for `0040` and `0041` and two new rules: a chart of
    accounts is eight closed codes, and a money movement is a balanced group that never changes.
    The rules after 29 were renumbered (31 to 30, 32 to 31, 34 to 32, 35 to 33) so that the
    numbering rule stayed at 36 with the two new rules at 34 and 35, and the introduction now says
    forty one files.
  - README.md - the database section describes the chart and the ledger, directly above the
    `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0039`, every
  `lib/` module, `config/`, the environment contract, settlements, holds, reserves and payouts
  (026), the ledger screens and the balance widget, the statement export, the reconciliation job,
  the tax collector, the subscription charge job, the permissive RLS policies (035) and every code
  STEP. `package.json` is untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0040_ledger_accounts` and `0041_ledger_entries`, each with its
  `.down.sql`. Together they create two tables, 33 columns, 32 constraints, nine indexes, 35
  comments, seven functions and seven triggers. The schema now holds forty one tables, forty one
  policies, sixty eight triggers and thirty two functions in `public`.
- Shape per table: `ledger_accounts` 13 columns, 12 constraints, three indexes, 14 comments, two
  triggers; `ledger_entries` 20 columns, 20 constraints, six indexes, 21 comments, five triggers
  (four row triggers and the deferred balance constraint trigger).
- Money is `bigint` minor units beside a three letter currency, as every money table since STEP
  018. MASTER_PROMPT rule 2 says `numeric(18,4)`; this schema stores minor units so that no float
  and no rounding rule can differ between two tables, and STEP 018, STEP 020, STEP 021, STEP 022
  and STEP 024 already recorded the same decision.
- Two partial unique indexes carry the two chart scopes: `ledger_accounts_platform_code_key` where
  `company_id is null` and `ledger_accounts_company_code_key` where it is not, so the platform holds
  one row per code and each merchant repeats the code inside its own chart.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All forty one
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the forty one forward
  files applied again to a second empty database, recreating exactly forty one tables, forty one
  policies, sixty eight triggers and thirty two functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic display names, a
  synthetic processor key ciphertext and synthetic transaction identifiers in throwaway local
  databases, and no real provider, merchant or card value was written anywhere.
- The working tree survived from STEP 024 at commit `b25ff20`; Node.js 26.13.0, the installed
  dependencies and PostgreSQL 16.2 from the `pgserver` wheel were reused, and `npm run verify` was
  exit 0 at that commit before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Two scripts ran against the local PostgreSQL 16.2 with 32 and 52 checks; all passed and each ended
with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0041` applied in order and produced forty one tables, forty one
   policies, sixty eight triggers and thirty two functions.
2. **Every table shape holds.** `ledger_accounts` reported 13 columns and 12 constraints and
   `ledger_entries` 20 and 20, with three and six indexes, two and five triggers, and 14 and 21
   comments, with RLS on and one policy each.
3. **The chart is a closed vocabulary.** An account code outside the eight was refused, and the
   side vocabulary was read back from `pg_get_constraintdef` as `debit` or `credit` and nothing
   else; an unknown kind was refused by `ledger_accounts_kind_check`.
4. **A kind has one normal side.** An asset with a credit side and an income with a debit side were
   both refused by the pairing check, while the eight codes of section 11 were accepted.
5. **A chart row closes one way.** An active account carrying a close instant, a closed account with
   no close instant and a close instant before the opening one were refused; closing with its
   instant succeeded, and a removed row freed its code for a fresh one.
6. **Two scopes, two keys.** The platform chart held the eight codes with no owner, the merchant
   chart added its own copy of two codes and a second merchant one, and the same platform code twice
   and the same merchant code twice were refused by their own indexes.
7. **A chart identity is frozen.** A changed code, a changed kind and an owner moved to another
   merchant were refused with "keeps its code, its kind, its side and its owner", while a rename
   succeeded and bumped the version to 2.
8. **A group needs both sides.** A single debit, a second debit that left the group one sided, a
   group whose two sides differed, a group in two currencies and a group across two merchants were
   each refused by the deferred trigger, and a balanced pair committed with both sides at 10000.
9. **The balance check is deferrable.** `ledger_entries_balanced` reported `tgdeferrable` and
   `tginitdeferred` both true, so a writer may insert the debit before the credit inside one
   transaction and the group is judged at commit.
10. **An entry is one side of one number.** An entry of nothing, a negative amount, an unknown side,
    an unknown source type, a lower case currency, a padded description and a description of 281
    characters were each refused by name, and the source vocabulary was read back as the ten
    movements of section 11.
11. **A source type carries its own row.** A payment source with no payment, a hold carrying a
    payment, a refund source with no refund, a chargeback with no dispute and a settlement carrying
    a dispute were each refused by their pair checks.
12. **An entry stays inside its merchant chart.** An entry into another merchant's account was
    refused, while a merchant posting to the platform accounts committed.
13. **A posted entry never changes.** An edited amount, an edited description and a removal were all
    refused with "ledger entries are append only", and one trigger carries both the update and the
    delete event.
14. **A correction is a mirror.** A reversal on the same side, a reversal of another amount, a
    reversal in another currency, a reversal inside the group it undoes and a second reversal of the
    same entry were each refused, while the correct mirror committed as its own balanced group.
15. **A partial payment moves the invoice.** Posting 4000 against a 10000 invoice left it
    `partially_paid` with `amount_paid_minor = 4000` and no paid instant; a second payment of 6000
    settled it at 10000 and `paid` with its instant.
16. **An overpayment does not inflate the invoice.** A third payment of 5000 on the paid invoice
    left it at `paid` and 10000, with the excess staying in the ledger and no error, because the
    paid lock already froze the row.
17. **An invoice that cannot hold the state is refused loudly.** A payment against a draft invoice
    with no number and no issue instant was refused with "a payment cannot settle an invoice that
    was never issued", a payment against a zero total with "whose total is zero", and a partial
    payment of 1500 under the 20 USD floor with its own message; the three invoices were untouched
    afterwards.
18. **A refund posts its own pair.** A refund of the first payment posted a balanced pair with its
    `refund_id` on both sides.
19. **Row level security.** A plain role saw zero entries and could not write one, while the owner
    saw all fourteen entries and the whole ledger summed to the same total on both sides, 39500
    each.
20. **Rollback and re-apply.** The forty one rollbacks emptied the `public` schema completely,
    removed every function, and the forty one forward files rebuilt it on a second database with no
    rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1233 checks, 41 migrations, 41 tables, every
  forward file transactional and default-deny` (1203 after the chart, 1173 before this STEP).
- Gate mutation probes, each caught and reverted: removing the closing `commit;` ("must end with
  commit;"), removing `enable row level security` ("table ledger_entries must enable row level
  security in this file"), renaming the policy ("must carry its default-deny policy in this file"),
  writing a non ASCII character in a comment ("must be ASCII only"), moving
  `0041_ledger_entries.down.sql` away ("has no rollback file") and removing the `version` column
  ("is missing the required column version").
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: detaching `ledger_entries_guard_append_only` made the proof report "refused: an edited
  entry" and "refused: a deleted entry"; detaching `ledger_entries_guard_reversal` made it report
  "refused: a reversal on the same side" and three more reversal labels; detaching
  `ledger_entries_guard_account` made it report "refused: an entry into another merchant's account";
  detaching `ledger_entries_sync_invoice` made it report "a payment of 4000 on a 10000 invoice makes
  it partially paid" and the three refusals that depend on the sync; and detaching
  `ledger_entries_balanced` made it report every group label plus "the owner sees every entry and
  the whole ledger balances".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 1233 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII, checked with a byte grep for
  characters outside the printable range.

## Errors Found And Corrected In This STEP
1. **A constraint count written before it was measured.** The chart was planned with more
   constraints than it measured, so the proof asserts the measured 12, and the entries down file's
   comment was written as twenty constraints and six indexes from the catalog rather than from a
   plan.
2. **A neighbouring check that hijacked a vocabulary probe.** An unknown `side` failed
   `ledger_accounts_pairing_check` before `ledger_accounts_side_check`, because the pairing check
   reads the side. The probe now accepts either refusal and asserts the side vocabulary from
   `pg_get_constraintdef`, so neither check masks the other.
3. **A reversal probe that reversed the wrong side.** Three reversal probes pointed at the credit
   entry while using a debit side, so they were correct reversals and failed the balance check
   instead. The probes were corrected to reverse the stored side; the trigger was right.
4. **A payment seed that STEP 024 requires more of.** The proof's payments needed `authorized_at` as
   well as `captured_at`, because `payments_authorized_instant_check` follows the status; the seed
   was corrected rather than the schema.
5. **An invoice tie that needed two refusals before it was honest.** The first draft of
   `ledger_entries_sync_invoice` would have written the paid state onto a draft invoice, which
   `invoices_issue_check` rejects with its own message, and onto a zero total, which is not a
   settlement. The sync now refuses both with a sentence that names the cause, and a partial payment
   under the section 16 floor is refused the same way.
6. **A single row probe that could not commit.** A pair was first posted as two separate
   statements in autocommit, so each group held one row and the deferred trigger refused it. The
   proof now posts every group inside one transaction, which is also the shape a real posting
   service uses.

## Decisions And Limits Left For Later STEPs
- **The ledger is a table, not a service.** This STEP proves the shape and the guarantees; the code
  that decides which accounts a payment, a fee or a chargeback posts to, and in what order, is a
  later STEP. A writer today must choose the accounts and the group itself.
- **The invoice paid total now has one writer.** `ledger_entries_sync_invoice` writes
  `invoices.amount_paid_minor` and its `partially_paid` or `paid` state from the posted payments, so
  the gap STEP 024 recorded is closed. An invoice is settled at its total; an overpayment stays in
  the ledger and does not raise the total.
- **An invoice must be issued before it can be paid.** A draft has no number and no issue instant,
  so the sync refuses the posting rather than inventing a number, because numbering belongs to the
  merchant's documents and not to a trigger.
- **The fee, hold, reserve, settlement, payout and subscription charge postings have no source table
  yet.** Their source types exist and their `source_id` is a plain uuid, so STEP 026 and the
  subscription charge STEP can point them at their own rows without a migration here.
- **No balance column and no running total.** The balance of an account is a sum over the entries,
  not a stored number, because a stored balance is a second truth that can drift. A materialised
  balance, if it is ever needed, is a later STEP with its own proof.
- **Deleting an entry is impossible, including for the platform.** There is no void entry, no soft
  deleted entry and no correction path other than a reversal, and reversing a reversal is a new
  entry that names it rather than a rewrite of the original.
- **RLS stays default-deny** until STEP 035 grants the merchant its own entries and the office the
  whole ledger. The statement screen of section 11 reads through that policy.
- **No reconciliation and no mismatch alert.** Matching the ledger against the processor report is
  the reconciliation job of a later STEP; this schema is the side it reads.
- **The chart has no tax, fee or reserve account per merchant.** The eight platform codes carry the
  platform's own money and each merchant may add the same codes to its own chart; a merchant
  specific code is not in the vocabulary and would need a migration that widens it.

## Next Chat Notes
- Next in this category is STEP 026, the settlements, holds, reserves and payouts. Every one of them
  posts against this ledger, and their entries use the source types that already exist here.
- A posting is always a group: insert both sides inside one transaction and let the deferred trigger
  judge the sum. A single insert, or two inserts outside a transaction, is refused.
- A group is one currency and one merchant. A cross currency movement is two groups or a conversion
  entry, not one group with two currencies.
- The platform accounts belong to no merchant, and an entry may post to them from any merchant; a
  merchant's own account may only be used by that merchant.
- An entry cannot be corrected. Reverse it: the mirror must be the opposite side, the same amount,
  the same currency and merchant, in a group of its own, and no entry is reversed twice.
- `invoices.amount_paid_minor` is written only by `ledger_entries_sync_invoice`. A service that
  wants to mark an invoice paid posts the payment entries, and it must issue the invoice first.
- A partial payment needs 2000 minor units in USD; below that the invoice has no legal state and the
  posting is refused rather than silently ignored.
