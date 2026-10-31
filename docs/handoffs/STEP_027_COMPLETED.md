// path: docs/handoffs/STEP_027_COMPLETED.md
# STEP 027 Completed - Handoff

## STEP
- Number and title: STEP 027 - Migration for payout bank accounts and bank change requests
  tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 026 (the payouts
  whose destination was a snapshot until this STEP, and the settlement behind them), STEP 025
  (the ledger a payout posts to) and STEP 003 (the users who verify a change by hand). STEP 028
  is the compliance and underwriting STEP that reads these rows, and STEP 035 the permissive
  policies. The owner asked for this STEP directly; it was still split into three sub-steps with
  an approval between each, and the plan is `docs/planning/STEP_027_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0046_payout_bank_accounts.sql and 0046_payout_bank_accounts.down.sql - the payout
    bank account with its number as AES-256-GCM ciphertext, its visible tail, its fingerprint,
    its five statuses, one active account per merchant, its guard and the
    `payouts.bank_account_id` column with its composite foreign key.
  - migrations/0047_bank_change_requests.sql and 0047_bank_change_requests.down.sql - the change
    request with its two accounts, its six statuses, the 96 hour cooling check, one open request
    per merchant and its guard.
  - docs/planning/STEP_027_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_027_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows for `0046` and `0047` and two new rules: a bank
    account is ciphertext and a life, and a bank change is 96 hours or it is not a change. The
    numbering rule moved from 38 to 40 and the introduction now says forty seven files.
  - README.md - the database section describes the account and the change, directly above the
    `uuid_generate_v7()` bullet.
  - migrations/0045_payouts.sql and its rollback are untouched; the only change to a table of an
    earlier STEP is the column and foreign key that STEP 026 promised in its handoff.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: migrations `0001` to
  `0045` except the promised `payouts` column, every `lib/` module, `config/`, the environment
  contract, the payout settings screen, the Payoneer and Airwallex account calls, the payout
  pause logic, the notification emails, the permissive RLS policies (035) and every code STEP.
  `package.json` is untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0046_payout_bank_accounts` and `0047_bank_change_requests`,
  each with its `.down.sql`. Together they create two tables with 42 columns, 46 constraints,
  nine indexes, 45 comments, two functions and four triggers, and they add one column, one
  foreign key, one index and one column comment to `payouts`. The schema now holds forty seven
  tables, forty seven policies, eighty two triggers and forty functions in `public`.
- Shape per table: `payout_bank_accounts` 24 columns, 25 constraints, five indexes, 25 comments,
  two triggers; `bank_change_requests` 18 columns, 21 constraints, four indexes, 19 comments,
  two triggers. `payouts` grew from 26 columns, 30 constraints and four indexes to 27, 31 and
  five.
- A secret is ciphertext, as in STEP 023: `account_number_ciphertext`, `account_number_iv`,
  `account_number_tag` and `encryption_key_version`, with `account_last_four` for the merchant
  and `account_fingerprint` for a duplicate check that needs no decryption. A query over the
  columns of the table finds no plain account number, no IBAN and no routing number.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All forty
  seven rollbacks ran in reverse dependency order on populated databases; afterwards the catalog
  reported 0 public tables, 0 policies, 0 triggers and 0 functions in `public`, the
  `bank_account_id` column was gone from `payouts`, and the forty seven forward files applied
  again to a second empty database, recreating exactly forty seven tables, forty seven policies,
  eighty two triggers and forty functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs wrote synthetic ciphertext, a
  synthetic initialisation vector and tag, a synthetic bank name, a synthetic four character
  tail and a synthetic fingerprint in throwaway local databases, and no real account number,
  bank credential or provider secret was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Two scripts ran against the local PostgreSQL 16.2 with 40 and 35 checks; all passed and each
ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0047` applied in order and produced forty seven tables, forty
   seven policies, eighty two triggers and forty functions.
2. **Every table shape holds.** `payout_bank_accounts` reported 24 columns and 25 constraints
   and `bank_change_requests` 18 and 21, with five and four indexes, two triggers each, 25 and
   19 comments, RLS on and one policy each; `payouts` measured 27 columns, 31 constraints and
   five indexes after the new column.
3. **No plain account number exists.** A query over the columns of the account table for
   `account_number`, `iban`, `routing_number`, `swift` and `account_number_plain` returned no
   row, and the ciphertext column is required.
4. **An account has a life.** A submitted account waited as `pending` with its four characters,
   a verified one required both the instant and the person, a rejected one required its note, an
   active one required its activation instant, and a verification before the submission was
   refused.
5. **The account fields are checked.** A padded bank name, a lower case country, a five
   character tail, an upper case fingerprint, a ciphertext shorter than a block and an unknown
   status were each refused by name.
6. **One active account.** A verified account became active with its instant at version 2, a
   second active account for the same merchant was refused by `payout_bank_accounts_active_key`,
   and the same fingerprint could not be added twice while it is live.
7. **An account is frozen.** Renaming a verified account and pointing it at another number were
   refused with "a bank account keeps its merchant, its holder, its bank and its number", a
   retired account was refused a rename and refused a delete, and a retired row freed its
   fingerprint.
8. **A payout names its account.** A payout with its own merchant's verified account stored the
   account id, and a payout naming another merchant's account or an account that does not exist
   was refused by `payouts_bank_account_fkey`.
9. **A change request has a life.** A request waited unverified with the account in use named,
   the manual verification recorded its person at version 2, the cooling stored exactly the
   verification instant plus 96 hours, and the change activated at the end of the cooling at
   version 4.
10. **The 96 hours cannot move.** A cooling of 48 hours and a cooling of 97 hours were both
    refused by `bank_change_requests_cooling_length_check`, a cooling status with no instant was
    refused by `bank_change_requests_cooling_instant_check`, and an activation before the end of
    the cooling was refused by `bank_change_requests_activated_after_cooling_check`.
11. **A failed verification starts nothing.** A rejected request carried its reason and no
    cooling instant, and a rejected request that tried to open a cooling was refused with "a
    closed bank change request is history".
12. **A request stays inside its merchant.** A request naming its own account twice was refused,
    a request for another merchant's account was refused by
    `bank_change_requests_requested_fkey`, a request naming another merchant's current account
    by `bank_change_requests_current_fkey`, and a second open request for the same merchant by
    `bank_change_requests_open_key`.
13. **The request is frozen and closed one way.** A request pointed at another account was
    refused with "a bank change request keeps its merchant, its accounts and its requester", and
    an activated request annotated was refused with "a closed bank change request is history".
14. **One at a time.** Another merchant opened its own request, the request was cancelled, and
    the cancellation freed the merchant for a fresh request.
15. **The request indexes answer their screens.** With sequential scans disabled the planner
    used `bank_change_requests_queue_idx` for what still needs a person and
    `bank_change_requests_account_idx` for the account lookup.
16. **Row level security.** A plain role saw no account and no request and could not write
    either, while the owner saw its three accounts and its two requests.
17. **Rollback and re-apply.** The forty seven rollbacks emptied the `public` schema, removed
    every function and removed the column this STEP added to `payouts`, and the forty seven
    forward files rebuilt it on a second database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1413 checks, 47 migrations, 47 tables,
  every forward file transactional and default-deny` (1383 after the account, 1353 before this
  STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from
  `0046` and from `0047`, renaming the policy in `0046` and in `0047`, removing the closing
  `commit;` from `0047`, removing the `version` column from `0046`, and moving
  `0046_payout_bank_accounts.down.sql` and `0047_bank_change_requests.down.sql` away, each
  refused by the sentence the gate names.
- Behaviour mutation probes, each run against the proof that exercises the rule and each
  restored afterwards: detaching `payout_bank_accounts_guard_state` made the proof report the
  rename, the number swap and the two retired labels; detaching
  `bank_change_requests_guard_state` made it report the account label, the annotated label and
  the rejected cooling label.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes;
  lint 77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and
  4 slots; migrations 1413 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII, checked with a byte grep
  for characters outside the printable range.

## Errors Found And Corrected In This STEP
1. **A probe that expected the wrong guard.** Renaming a retired account reports the frozen
   identity, because the identity guard runs before the closed lock; the probe now expects that
   sentence and a separate move of `retired_at` proves the lock.
2. **A cooling that the pair check did not catch.** A cooling instant written without a
   verification behind it passes the status pair check and is refused by the length check, which
   is the more precise rule; the probe asserts that and a second probe covers the pair.
3. **A foreign key probe that a unique index pre-empted.** Check constraints and unique indexes
   are evaluated before the after-trigger foreign key, so a cross-merchant request from a
   merchant that already had an open request reported the one-open-request key instead of the
   foreign key. The two foreign key probes now ask from the merchant with no open request.
4. **A seed that named one account twice.** The second merchant's first change request pointed
   its current and requested account at the same row, which
   `bank_change_requests_accounts_check` refuses; the proof seeds a second verified account for
   that merchant, which is also the real shape of a change.

## Decisions And Limits Left For Later STEPs
- **The pause is a query, not a trigger.** This STEP stores the cooling window; the payout
  service must refuse a payout while an open request exists with a cooling end in the future. A
  trigger on `payouts` that read this table would also stop the office from recording a
  provider's own payout history, so the rule stays with the service that owns the decision.
- **The ciphertext is written by the service.** The schema bounds its shape and freezes it, but
  the AES-256-GCM encryption, the key version and the fingerprint of the normalised number
  belong to the crypto module and the environment contract; nothing here chooses a key.
- **The merchant's own confirmation is not recorded here.** Section 10 shows the reserve terms
  at signup and this STEP needs the same discipline for a bank change, but the consent record
  belongs to the settings STEP that owns the profile screens.
- **The Payoneer and Airwallex calls are provider work.** "The bank is added automatically to
  Payoneer or Airwallex" is an adapter call, not a column; this STEP stores the account and its
  verification, and the adapter STEP will name the provider row it pushed to.
- **Step-up reauthentication is a session rule.** The row records who verified; proving that
  person re-authenticated belongs to the session STEP.
- **The emails are not sent here.** A verified, rejected or activated change is one of the
  activity emails of section 22, and the notification STEP sends them.
- **No underwriting decision is stored.** Section 6 risk tiers and the extra reserve they carry
  are the compliance STEP; this table only says which account is allowed to receive money.
- **RLS stays default-deny** until STEP 035 grants the merchant its own accounts and requests
  and the office the verification queue.

## Next Chat Notes
- Next in this category is STEP 028, the compliance and underwriting tables that read the
  accounts and the KYC documents this STEP verifies by hand.
- A bank account number is never read as text. A service decrypts with the key version on the
  row, writes the ciphertext back only through a new row or a re-encryption STEP, and compares
  accounts by fingerprint rather than by number.
- The payout bank account that money goes to is the single row with status `active`. Retiring it
  and activating another is one transaction: retire the old, activate the new, and the partial
  unique index keeps that honest.
- A change request is the record of section 10: verification first, then exactly 96 hours, then
  the activation. A rejected request has no cooling instant and the previous account stays
  active.
- `payouts.bank_account_id` is optional because a payout may be recorded from a provider report
  before the account row exists; the three snapshot columns of STEP 026 remain the audit record
  either way.
