// path: docs/planning/STEP_027_SUBSTEP_BREAKDOWN.md
# STEP 027 - Sub-Step Breakdown

The owner asked for this STEP directly, and the standing rule still holds: it is split first and
it stops for permission before any SQL is written. This document is sub-step 027.1. The proof
belongs in `docs/handoffs/STEP_027_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 027 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for payout bank accounts and bank change requests tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 026 created `payouts`, whose destination is a snapshot today and whose
  foreign key to a verified account is exactly what this STEP promised to add; STEP 025 the
  ledger a payout posts to; STEP 003 the `users` who verify a change. The payout settings
  screen, the 96 hour pause and the verification workflow are code STEPs.

### Feature list lines that fix the shape
- Section 10:
  - "Merchants add a payout bank account in profile payout settings. The bank is added
    automatically to Payoneer or Airwallex."
  - "Changing a bank account requires manual verification first. The 96 hour cooling period
    starts only after manual verification passes."
  - "During the cooling period all payouts are fully paused, including to the previous verified
    bank."
  - "When manual verification fails, the cooling period never starts and the previous bank stays
    active."
  - "Minimum payout amount is 100 USD." and "Failed payouts are reported to the merchant by
    email."
- Section 5: `finance_ops` handles failed payouts and settlement release work, and a large
  payout release needs the CEO confirmation step, so a person verifies a bank change rather than
  the row verifying itself.
- Section 9: "bank account fingerprint" is one of the identity signals the platform stores.
- Section 13: "When a merchant closes the account, remaining money is sent to the bank after the
  hold period" - the account a merchant closes with is the account row this STEP stores.
- Section 22: step-up reauthentication is required for payouts and KYC decisions; the row
  records who verified and when, and the session STEP owns the step-up itself.
- STEP 026 handoff: "STEP 027 adds the foreign key column to `payouts` when its table exists."
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with
  RLS enabled and a default-deny policy. Money is minor units; a secret is ciphertext, never a
  column of plaintext.

### What exists today (measured before coding)
- 45 migrations, 45 tables, 45 policies, 78 triggers, 38 functions in `public`; gate 1353
  checks.
- `payouts` (STEP 026) has 26 columns and 30 constraints, and its destination is three text
  columns: `destination_bank_name`, `destination_last_four`, `destination_country`, all present
  or all absent, and required on a paid payout. There is no `bank_account_id` column yet.
- `provider_keys` (STEP 023) is the precedent for a secret: `key_ciphertext`, `key_iv`,
  `key_tag`, `encryption_key_version`, a fingerprint of 64 lower case hex characters and four
  visible characters, with a guard that refuses new ciphertext under an unchanged key version.
  This STEP mirrors that shape for a bank account number.
- `holds` and `settlements` (STEP 026) show the pattern for a frozen identity and a terminal
  state.

## 2. Design Decisions Taken Before Coding

1. **The account number is ciphertext, never a column of digits.** `payout_bank_accounts` stores
   `account_number_ciphertext`, `account_number_iv`, `account_number_tag` and
   `encryption_key_version`, exactly as `provider_keys` stores a processor key, plus
   `account_last_four` for the merchant to recognise the account and `account_fingerprint`
   (SHA-256, 64 lower case hex) so the same account can be detected without decrypting anything.
2. **A bank account has a life, not just a flag.** The status vocabulary is `pending`,
   `verified`, `rejected`, `active` and `retired`. `pending` is submitted and waiting;
   `verified` means a person passed it; `active` means payouts may use it; `rejected` and
   `retired` are the two ends. Each state carries its own instant, and the two people columns
   (`verified_by`, and the rejection note) are bound to their states by checks.
3. **One active account per merchant.** A partial unique index on `(company_id)` where the
   status is `active` and the row is live makes "the bank we pay to" a single answer, while the
   retired rows stay as history. A second partial unique index on `(company_id,
   account_fingerprint)` for live rows stops the same account being added twice.
4. **Verification is a person, not a timestamp.** `verified_at` and `verified_by` arrive
   together, `rejected_at` requires a reason, and a guard freezes the identity of the row
   (merchant, bank name, holder, country, currency, tail, fingerprint and the cipher quartet) so
   a verified account cannot be quietly turned into another account. `rejected` and `retired`
   are terminal.
5. **A change request is its own row, with the 96 hours in it.** `bank_change_requests` names
   the current account, the requested account, who asked, who verified, when it was rejected and
   when the cooling ends. `cooling_ends_at` is a check against the verification instant plus
   `interval '96 hours'`, so section 10's 96 hours cannot be shortened by a caller, and a
   rejected request never gets a cooling instant at all - which is the sentence "the cooling
   period never starts".
6. **Only one change runs at a time.** A partial unique index on `(company_id)` for the open
   statuses (`requested`, `verified`, `cooling`) stops two parallel requests from racing for the
   same merchant.
7. **The payout reaches its account by foreign key.** `0046` adds `bank_account_id` to `payouts`
   with a composite foreign key on `(bank_account_id, company_id)`, so a payout cannot name
   another merchant's account, and keeps the three snapshot columns of STEP 026 because an audit
   reads the row as it was even after the account is retired. This is the one change to a table
   STEP 026 created, and STEP 026 recorded it as the promised next step.
8. **The pause is a rule about a window, not a column on the merchant.** Section 10 pauses every
   payout during the cooling period; the row that says when the cooling ends is this table, so
   the payout service asks one question - is there an open request whose cooling has not ended -
   instead of trusting a flag that could drift.
9. **Both tables are default-deny** and both carry a row metadata trigger and a guard, as every
   money table since STEP 023 does.

## 3. The Schema This Produces

### `0046_payout_bank_accounts.sql`
`payout_bank_accounts` with the six audit columns plus `bank_name`, `account_holder`, `country`,
`currency`, `account_last_four`, `account_fingerprint`, the cipher quartet, `status`,
`submitted_at`, `verified_at`, `verified_by`, `rejected_at`, `rejection_note`, `activated_at`
and `retired_at`. Checks: the status vocabulary, the verified pair, the rejected pair with its
required note, the active and retired instants, the four character tail, the 64 hex fingerprint,
the country and currency shapes, the cipher lengths and the key version. Indexes: the primary
key, the one-active-account key, the fingerprint key and the merchant list. Triggers: the
identity guard, the row metadata trigger and the policy. The same file adds
`payouts.bank_account_id` with its composite foreign key and its index.

### `0047_bank_change_requests.sql`
`bank_change_requests` with `current_account_id`, `requested_account_id`, `status`,
`requested_at`, `requested_by`, `verified_at`, `verified_by`, `rejected_at`, `rejection_note`,
`cooling_ends_at`, `activated_at`, `note` and the six audit columns. Checks: the status
vocabulary, the verified pair, the rejected pair with its note, the cooling instant equal to the
verification instant plus 96 hours, the activated instant, a request whose two accounts differ,
and the trimmed note. Indexes: the primary key, one open request per merchant, and the queue of
what still needs a person. Triggers: the identity and terminal guard, the row metadata trigger
and the policy.

## 4. The Three Sub-Steps

### 027.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list and the STEP 026 handoff; measured the schema; fixed the design
above. No file outside this document is touched. It stops for permission.

### 027.2 - `0046_payout_bank_accounts.sql` and its rollback
The account table with its cipher columns, its life, its two partial unique indexes, its guard,
its indexes and its policy, plus the `payouts.bank_account_id` column and foreign key. Then a
proof that applies `0001` to `0046`, exercises every rule, and runs the rollback and the
re-apply.

### 027.3 - `0047_bank_change_requests.sql`, the docs, the verification and the commit
The change request with the 96 hour cooling, one open request per merchant, and its guards; then
the proof for it, the gate probes, the behaviour probes, the two README patches, `npm run
verify`, the handoff file and the single commit "STEP 027: Migration for payout bank accounts
and bank change requests tables" with its push.

## 5. Files This STEP Owns
- `migrations/0046_payout_bank_accounts.sql` and `0046_payout_bank_accounts.down.sql`
- `migrations/0047_bank_change_requests.sql` and `0047_bank_change_requests.down.sql`
- `migrations/README.md` (two inventory rows and up to two rules)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_027_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_027_COMPLETED.md`
- Not owned and not touched: `0001` to `0045` except the `payouts` column this STEP promised,
  every `lib/` module, `config/`, the environment contract, the payout settings screen, the
  provider Payoneer and Airwallex account calls, the payout pause logic, the notification
  emails, the permissive RLS policies (035) and every code STEP.
