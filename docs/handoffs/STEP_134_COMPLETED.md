# STEP 134 — Ledger balance integrity check job with office alerts

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_133_COMPLETED.md`.

## What this STEP is, in one paragraph

The ledger balance integrity check: the job that reads every group the ledger holds and proves each one
balances, alerting the office on any mismatch. Section 11 of the feature list says "the system continuously
checks that the ledger is balanced and alerts the office on any mismatch." The posting service (STEP 132)
refuses an unbalanced group before it is written, and the database's deferred constraint trigger refuses
it at commit. Those two guards make an unbalanced group rare. They do not make it impossible: a direct
database write that bypasses the service, a migration that altered a trigger, or a bug in a later STEP
could leave a group whose debits and credits are not equal. This job is the safety net that catches what
the guards prevent from happening. It reads every group the store holds, sums the debits and the credits
of each, and reports the result. A group whose debits and credits are equal is balanced; a group whose
debits and credits are not equal is unbalanced, and an alert is created for the office.

## What it is not

- **It is not the posting service.** It does not write entries; it reads them. STEP 132 owns the posting.
- **It is not the reversal service.** It does not create corrections; it reports what is there. STEP 133
  owns the reversal.
- **It is not the reconciliation.** Section 11's reconciliation matches system records with processor
  reports. This STEP checks that the ledger's own groups balance; it does not match against external
  reports. That is a later STEP.
- **It is not the office alert system itself.** It produces alerts; the delivery, storage and audit-logging
  of alerts is the jobs system's business. This file is the check that produces the alert data.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `checkLedgerBalance` and surface the report.
- **It does not need a migration.** The `public.ledger_entries` table, its `entry_group_id` column, and
  its indexes all exist from STEP 025 (migration 0041). Sub-step 3 was "if any", and it was not.
- **It does not touch a provider.** It reads ledger entries; it does not call any provider's API.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §11, MASTER_PROMPT money rules, STEP 133 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/ledger-balance.ts` — STEP 134 owns it; `lib/payments/ledger-posting.ts` extended with `listGroupIds` | — |
| 3 | Database part | **none needed** — migration 0041 already created the table and its indexes | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/ledger-balance.ts`: balance check with office alerts | payments-ledger-balance gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service reads the store; it does not write entries; the store is the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`LedgerGroupBalance`** — the balance of one ledger group: its entry group id, its company, its debits,
  its credits, whether it balances, and the difference (debits - credits).
- **`LedgerBalanceAlert`** — an alert for the office: the unbalanced group, its company, its debits, its
  credits, its difference, and the time the mismatch was detected.
- **`LedgerBalanceReport`** — the report of a balance check: the time it ran, the total groups, the
  balanced count, the unbalanced count, the per-group balances, and the alerts.
- **`checkLedgerBalance(store)`** — the service that reads every group the store holds and returns the
  report.

## The check flow, step by step

1. **List every group.** The store is asked for the ids of every group it holds.
2. **For each group, sum the debits and the credits.** The entries of the group are read, and the amounts
   on each side are summed.
3. **Compute the difference.** debits - credits. Zero means the group balances; non-zero means it does not.
4. **Build the per-group balance.** The `LedgerGroupBalance` carries the group id, the company, the
   debits, the credits, the balanced flag, and the difference.
5. **Create an alert for each unbalanced group.** The `LedgerBalanceAlert` carries the same numbers plus
   the detection time.
6. **Return the report.** The `LedgerBalanceReport` carries the checked-at time, the counts, the
   per-group balances, and the alerts.

## Verification

| Gate | Result |
|---|---|
| payments-ledger-balance (`lib/payments/ledger-balance-verify.ts`) | **33 checks PASSING** — a balanced group is reported as balanced, an unbalanced group is reported as unbalanced with its debits, credits and difference, an alert is created for the office, the report counts are correct, the report covers every group in the store, an empty store produces an empty report, a reversal group is also checked |
| payments-ledger-reversal (STEP 133) | 26 checks PASSING (unchanged) |
| payments-ledger-posting (STEP 132) | 34 checks PASSING (unchanged) |
| payments-ledger-accounts (STEP 131) | 33 checks PASSING (unchanged) |
| payments-creation (STEP 130) | 24 checks PASSING (unchanged) |
| payments-routing (STEP 129) | 24 checks PASSING (unchanged) |
| payments-registry (STEP 128) | 42 checks PASSING (unchanged) |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The balance proof, as recorded

The STEP title names the behaviour, and the gate proves it eight ways:

1. **A balanced group is reported as balanced.** A group posted through the posting service appears in
   the report with `balanced: true` and `difference: 0n`.
2. **An unbalanced group is reported as unbalanced.** A group inserted directly into the store with
   debits ≠ credits appears in the report with `balanced: false` and a non-zero difference.
3. **The difference is computed correctly.** The difference is debits - credits. A group with debits
   10000 and credits 5000 has a difference of 5000.
4. **An alert is created for an unbalanced group.** The report's alerts array contains one alert naming
   the unbalanced group, its company, its debits, its credits, its difference, and the detection time.
5. **No alert is created for a balanced group.** The report's alerts array is empty when every group
   balances.
6. **The report counts are correct.** totalGroups = balancedGroups + unbalancedGroups. A mixed store
   with two balanced and one unbalanced group produces totalGroups = 3, balancedGroups = 2,
   unbalancedGroups = 1.
7. **The report covers every group in the store.** Every group id in the store appears in the report.
8. **A reversal group is also checked.** After a group is posted and reversed, the report counts two
   groups, both balanced, with no alerts.

## The safety-net proof, as recorded

The posting service (STEP 132) and the database's deferred constraint trigger (migration 0041) together
make an unbalanced group impossible through normal operation. This STEP's gate proves the safety net
catches what those guards prevent by inserting an unbalanced group directly into the store — bypassing
the posting service — and showing that the balance check reports it as unbalanced with an alert. The
gate does not test the guards; it tests the safety net that exists because the guards are not absolute.

## Package request

None. The ledger balance check is a plain TypeScript module with no dependencies beyond the `LedgerEntry`
and `LedgerEntryStore` types from `lib/payments/ledger-posting.ts` (STEP 132).

## What is next

STEP 135 — "Platform fee calculation and posting per transaction" — owns the fee that the platform keeps
from every transaction, which posts as a debit against the merchant's payable and a credit against the
platform's fee income. STEP 134 checks that the ledger is balanced; STEP 135 adds one of the movements
the ledger covers.
