// path: docs/planning/AUDIT_STEPS_001_030.md

# Audit of STEP 001 to STEP 030

Date: 2026-10-31. Owner request: re-check every STEP from the first to STEP 030, line by line,
and correct anything wrong before pushing again.

This document records what was checked, what was found and what was changed. It is not a STEP:
no migration was edited, because the first rule of this folder is that a committed migration is
never edited and a correction is a new migration. Only documentation changed.

## 1. What Was Checked

### 1.1 The schema the migrations produce

The fifty six forward files were applied in order on PostgreSQL 16.2 and the result was read
from the catalog rather than from the files:

- Every table has its conventional columns, `id` defaulting to `public.uuid_generate_v7()`, a
  primary key on `id`, a `<table>_set_row_metadata` before-update trigger except the append-only
  `audit_logs` which has none by design, row level security on, and exactly one permissive
  policy named `<table>_default_deny` reading `using (false) with check (false)`.
- Every tenant table has `company_id not null` and a foreign key to `companies`. The three
  platform scopes (`payment_providers`, `provider_keys`, `routing_rules`), the two later
  platform tables (`card_blacklist`, `velocity_counters`) and the tables whose tenant is
  deliberately optional for platform work (`users`, `sessions`, `role_assignments`,
  `announcement_dismissals`, `login_attempts`, `account_locks`, `delegations`,
  `office_permissions`, `announcements`, `audit_logs`) were read one by one and judged
  intentional.
- Every function pins `search_path` to the empty string. The two `security definer` functions
  are the audit log guards, and they need it, because a chain guard that ran as invoker could
  not read the head of a table whose policy refuses every read.
- All one hundred and four triggers are `before` or `after` as intended, `for each row`, and
  read the record they need: a `before insert` guard never reaches for `old`, and an append-only
  guard that reads neither record only raises.
- No index is invalid, no function is missing its comment, and a full descending rollback of all
  fifty six files left the `public` schema empty.

### 1.2 The rules each check enforces

- A scan for a check that can only pass through `null` found two candidates, `sessions` and
  `kyc_submissions`, and both are covered by a neighbouring check: `revoked_at` and
  `revocation_reason` are paired before the replay rule reads them, and the second reviewer can
  only exist on a decided submission, which already requires the first reviewer.
- A scan for a constraint that demands a column be `null` while the column is `not null` found
  one name that looked like a contradiction, `store_connections_platform_check`, and it is a
  check on the `platform` column rather than on `company_id`.
- Every guard function was read against the rule its own message states: the frozen columns
  match the message, the closed-row lock ignores only `updated_at` and `version` which
  `set_row_metadata` writes, and the one trigger that writes a derived column is the only writer
  allowed to do so, through `pg_trigger_depth()`.

### 1.3 The numbers the documentation prints

- The shape lines of every handoff (`N columns`, `N constraints`, `N indexes`, `N triggers`, `N
  comments`) were recomputed for all fifty six tables, with the comments counting the table
  comment plus the column comments.
- The forward apply line of each handoff (`N tables, N policies` at that step) was recomputed by
  applying `0001` to that step's last file on a clean database, at sixteen schema points.
- Each breakdown's what exists today line was recomputed at the state before its own first file.
- The `migrations/README.md` inventory was compared row by row: fifty six rows, in file order,
  one per forward file, with the index count of each row compared against its table.
- Every backticked SQL looking name in the two README files and the thirty handoffs was looked
  up in the catalog. The only miss is a constraint one handoff explains it deliberately removed.
- The next STEP each handoff names, the sections each handoff carries, and the root README
  bullets for STEP 012 to STEP 030 were checked for order, duplicates and gaps.

### 1.4 The behaviour

The proof scripts that still exist were re-run against the current schema:

- STEP 021 to STEP 030: twenty proof scripts (48 to 83 checks each), four detach probes (4 to 6
  checks each) and three row level security probes (3 to 4 checks each) all ended with `PROOF
  COMPLETE: 0 FAIL`. Two older scripts report failures only in their own hard coded counts of
  tables, policies and functions, which were correct when written and are stale now that later
  STEPs added tables; the behavioural checks inside them pass.
- STEP 017 to STEP 020 had no surviving script, so a fresh one was written with thirty seven
  checks: the audit chain (sequence, genesis link, fork, wrong parent, unique position, unique
  hash, refused update and removal, and the separate platform chain), the plan catalogue (code
  uniqueness and shape, period vocabulary, entitlement uniqueness per plan), the price list (the
  thirty day announcement rule and the retirement order), the subscription (period order,
  warning window, resume without stop, half written mandate, cancelled without its instant) and
  the three catalogues of STEP 020 (email per merchant, country shape, address rule, SKU and
  service code uniqueness, unit vocabulary).
- STEP 001 to STEP 016 were not re-run behaviourally, because their proof scripts are gone.
  Their claims were checked against the catalog instead, which is what section 1.1 to 1.3
  records.

## 2. What Was Wrong And What Changed

1. **Nine inventory rows counted indexes by a different rule.** The `migrations/README.md` table
   counted indexes two ways: forty seven rows printed the count a reader sees in `\d` (the
   primary key included), while nine rows printed only the indexes the file creates with a
   `create index` statement. The nine were `0014_plans`, `0016_pricing_versions`,
   `0019_clients`, `0020_products`, `0021_services`, `0029_payment_providers`, `0045_payouts`,
   `0055_card_blacklist` and `0056_velocity_counters`. All nine now print the catalog count, and
   a sentence above the table states the rule so the next row cannot drift again.

2. **One handoff was missing a section of the template.** `STEP_004_COMPLETED.md` had no
   Database section, although `docs/final/HANDOFF_TEMPLATE.md` says to delete nothing. The
   section now says that STEP 004 is a configuration STEP, adds no migration and has nothing to
   roll back.

3. **Nothing in the migrations was changed.** Every shape, rule, guard, index, policy and proof
   above was found correct, so the audit produced no new migration and no repair.

## 3. Observations Left For Later STEPs

These are not defects against the plan, and each is recorded so the STEP that owns it can
decide:

1. **Some tenant references are single column.** `invoices.client_id`, `payments.invoice_id` and
   similar columns are plain foreign keys, so the database does not stop a row of one merchant
   naming a row of another. The guards check tenancy where the plan demands it (line items,
   holds, ledger entries, sub-merchant provisioning) and the RLS policies of STEP 035 plus the
   service layer carry the rest. A composite `(id, company_id)` reference everywhere would be a
   new migration, not an edit.

2. **The payout minimum is a number without a currency.** `payouts_minimum_check` refuses
   anything under 10000 minor units unless it is the accumulated remainder, and the row stores
   its own currency, so 10000 is 100 USD only for a USD payout. Section 10 speaks of 100 USD; if
   the platform ever pays out in another currency, the threshold needs a per-currency setting.

3. **Document width is not uniform.** The handoffs and breakdowns of STEP 017 to STEP 027 wrap
   at about 100 columns, while STEP 028 to STEP 030 and this document wrap at 96. No rule in
   this repository states a width for Markdown, so nothing was rewrapped; a later documentation
   STEP may standardise it.

## 4. How To Repeat This Audit

The scripts are throwaway and live outside the repository, as every proof script in this project
does. The steps are: apply the forward files in order on an empty database; read the catalog for
the shapes, the policies and the comments; run the proof scripts of the STEPs in question; and
compare the numbers in the handoffs, the breakdowns and the two README files with what the
catalog reports.
