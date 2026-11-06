# STEP 131 — Double-entry ledger account setup per merchant

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_130_COMPLETED.md`.

## What this STEP is, in one paragraph

The ledger account setup service: the chart of accounts that every merchant reads and posts to, and the
two-scope opening logic that provisions it. Section 11 of the feature list says "every merchant has a full
payment ledger" and "double-entry method: every money movement writes a debit entry and a credit entry
and the pair always balances to zero." The chart of accounts is the vocabulary that makes those sentences
true: eight closed account codes, each with a kind and a normal side, and the pairing between them is not
a convention but a constraint. The chart exists twice — once for the platform, where the fee, the tax,
the reserve, the chargeback and the subscription accounts live (six accounts, `company_id` null), and once
per merchant, where the payable and the clearing accounts live (two accounts, `company_id` set). The
migration (0040) already made this two-scope design a database fact with two partial unique indexes; this
service is the code that opens each scope's chart. It is idempotent: opening a chart that is already open
returns the accounts it already has.

## What it is not

- **It is not the posting service.** It opens the accounts; it does not post entries against them. STEP 132
  owns the posting. The accounts this STEP opens are the rows STEP 132 will post to.
- **It is not the ledger entries table.** The migration (0041) already made the append-only, balanced-group,
  reversal-mirror rules database facts. This file is the chart: the definitions and the opening logic.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `openPlatformChart` and `openMerchantChart`.
- **It does not need a migration.** The `public.ledger_accounts` table, its eight closed codes, its kind
  and side pairing check, its two partial unique indexes, and its identity guard all exist from STEP 025
  (migration 0040). Sub-step 3 was "if any", and it was not.
- **It does not touch money.** It defines chart rows; it does not move a value. The double-entry proof rule
  applies to STEPs that post entries; this STEP opens accounts.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §11, MASTER_PROMPT money rules, STEP 130 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/ledger-accounts.ts` — STEP 131 owns it | — |
| 3 | Database part | **none needed** — migration 0040 already created the table | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/ledger-accounts.ts`: chart of accounts + two-scope opening | payments-ledger-accounts gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service defines chart rows; the store is the caller's (RLS/audit are the store's concern); it does not touch money or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The chart, where each account lives

- **`processor_clearing`** — asset, debit. Money the platform holds at the processor. Lives in the
  merchant chart.
- **`merchant_payable`** — liability, credit. What the platform owes the merchant. Lives in the
  merchant chart.
- **`platform_fee_income`** — income, credit. The section 10 fee the platform keeps. Lives in the
  platform chart.
- **`sales_tax_payable`** — liability, credit. The section 7 tax collected for the state. Lives in the
  platform chart.
- **`reserve_held`** — liability, credit. The section 10 rolling reserve. Lives in the platform chart.
- **`chargeback_loss`** — expense, debit. The money a lost chargeback takes. Lives in the platform chart.
- **`chargeback_fee`** — expense, debit. The section 18 chargeback fee. Lives in the platform chart.
- **`subscription_income`** — income, credit. The section 12 subscription charge. Lives in the platform
  chart.

## The kind/side pairing, as a rule

An asset or an expense is a debit account. A liability or an income is a credit account. This is the
pairing the `ledger_accounts_pairing_check` constraint enforces in the database, and the gate proves the
chart agrees with it: every one of the eight definitions has the normal side its kind implies. A row whose
side is wrong silently inverts every balance that reads it, so the pairing is not a comment the reader
trusts — it is a rule the gate proves.

## The two scopes, and why a merchant's ledger is full with two accounts

A merchant's ledger statement reads entries from both scopes. A payment debits the merchant's clearing
account and credits the merchant's payable. The platform fee debits the merchant's payable and credits the
platform's fee income. The reserve debits the merchant's payable and credits the platform's reserve. Every
entry is scoped to the merchant — that is what `ledger_entries.company_id` holds — even when the account
it posts to is a platform account. So a merchant with two accounts reads a full ledger, because every
entry that moves their money is theirs, whether it posts to their account or to the platform's.

## Verification

| Gate | Result |
|---|---|
| payments-ledger-accounts (`lib/payments/ledger-accounts-verify.ts`) | **33 checks PASSING** — chart is closed at 8 codes, kind/side pairing enforced, platform chart opens 6 accounts, merchant chart opens 2 accounts scoped to the company, the two scopes together cover the full chart with no overlap, opening is idempotent, the store holds exactly what was opened, all accounts active, all ids unique |
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

## The chart-closure proof, as recorded

The STEP title names the behaviour, and the gate proves it nine ways:

1. **The chart holds exactly eight codes.** `CHART_OF_ACCOUNTS.length === 8`. A ninth account is a new
   migration, not a hole in this list.
2. **No duplicate codes.** `new Set(chartCodes).size === chartCodes.length`. Each code appears once.
3. **Every display name is valid.** Trimmed, 1 to 80 characters — the same rule the database enforces
   with `ledger_accounts_name_check`.
4. **The kind/side pairing holds for every account.** Each account's `normalSide` is the side its
   `accountKind` implies, checked against `NORMAL_SIDE_OF`.
5. **The platform chart opens six accounts.** All with `companyId === null`, all codes from
   `PLATFORM_ACCOUNT_CODES`, no duplicates.
6. **The merchant chart opens two accounts.** All scoped to the company, all codes from
   `MERCHANT_ACCOUNT_CODES`, no duplicates.
7. **The two scopes together are the full chart.** The union of platform and merchant codes is exactly
   the eight chart codes, and the intersection is empty — no code appears in both scopes.
8. **Opening is idempotent.** Opening the same chart twice returns `already_open` with the same number
   of accounts. The store is not asked to open an account twice.
9. **The store holds exactly what was opened.** The platform store holds 6 accounts, the merchant store
   holds 2. No account is missing, none is extra.

## Package request

None. The ledger account setup service is a plain TypeScript module with no dependencies beyond
`node:crypto` for `randomUUID()` and `deepFreeze` from `lib/utils/freeze.ts`.

## What is next

STEP 132 — "Ledger posting service requiring balanced debit and credit pairs" — owns the posting service
that writes debit and credit entries against the accounts this STEP opened. STEP 131 opens the chart;
STEP 132 posts to it. The accounts this STEP produces are the rows STEP 132 will read to know where each
side of a money movement goes.
