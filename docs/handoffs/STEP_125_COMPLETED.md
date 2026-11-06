# STEP 125 — Settlement statement export CSV generation

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_124_COMPLETED.md`.

## What this STEP is, in one paragraph

A merchant downloads a settlement statement as a CSV file for any period they pick. The statement is
the merchant's own settlement balance — the `merchant_payable` ledger account `0040` keeps per
merchant — read one line per movement, newest first, for the two whole days the merchant names.
Section 17's "payments, fees, holds, reserve, refunds, chargebacks and payouts" maps onto `0041`'s
closed vocabulary of ten as the eight types the statement carries: the payment, the platform fee, the
hold, the reserve, the refund, the chargeback, the chargeback fee and the payout. The two that stay
out stay out on purpose: `settlement` is the batch the statement is about (its net is the sum of the
rows, so a row for it would count the period's money twice) and `subscription_charge` is the platform
billing the merchant for the software, not settlement money. Every line is a signed amount — a credit
to the payable is positive, a debit negative — so the merchant reconciles a plus against a sale and a
minus against a fee the way a bank statement is read. The file is RFC 4180 with CRLF line endings, the
header `date,type,amount,currency,description`, and it is one its own reader (`readCsv`) reads back.

## What it is not

- **It is not a PDF.** The PDF is STEP 126, the same statement rendered as a document with totals.
  This STEP is the CSV, and it carries no totals row — a totals row is a document's job, not a file's.
- **It does not need a migration.** `0040`'s `ledger_accounts` and `0041`'s `ledger_entries` already
  carry the account, the entries and `ledger_entries_statement_idx` ("the merchant statement, newest
  first"). Sub-step 3 was "if any", and it was not.
- **It does not write the ledger.** The ledger is append-only by `0041`'s own guard; a statement is a
  reading of a history, and there is nothing for this STEP to lock, guard or re-read. No audit entry
  is written: the rule that sends one to the audit log is "every mutation", and a read is not a
  mutation.
- **It is not a settlement batch.** `0042`'s `settlements` table records provider settlements with
  their net, hold days and status; it is the output of the payment core (STEPs 127+), not the source
  of this statement. The statement reads the ledger, because the ledger's index and `occurred_at`
  column were built for it.
- **It does not reach into another merchant's book.** The account is looked up by the session's own
  merchant id and the frozen code `merchant_payable`; no account id, company id or tenant ever comes
  from the query.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §17, MASTER_PROMPT rules, STEP 124 handoff | — | — |
| 2 | Confirm owned paths | `services/invoices/*` (106-126), the settlements API area, the settlements dashboard area | — |
| 3 | Database part | **none needed** — `0040`/`0041` already carry it | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `buildSettlementStatement` in `settlement-statement.ts`; the fields file carries the vocabulary, the window, the CSV writer and the rules | settlement-statement gate |
| 5 | API route | `app/api/settlements/statements/route.ts` (GET, no CSRF, no body) | gate + auth gate |
| 6 | UI | `app/(dashboard)/settlements/page.tsx` + `settlement-statement-panel.tsx` (two date inputs, Download CSV) | build 0 (156 routes) |
| 7 | Security | the `owner` role in the service, the tenant scope of every read, the 10,000-row ceiling, no audit (read, not mutation) | auth **2811 checks** (unchanged) |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The eight words** — `STATEMENT_SOURCE_TYPES` in `settlement-statement-fields.ts`, closed on the
  eight section 17 names. The two exclusions (`settlement`, `subscription_charge`) are absent from the
  list rather than present and filtered: a list that carries its own exclusions is a list the next
  reader has to re-read to learn what counts.
- **The sign from the side** — `merchant_payable` is a credit account by `0040`'s pairing check, so a
  credit to it is money the balance gains and a debit is money it loses. The service maps
  `entry_side === "credit" ? amount : "-" + amount`, where `amount` is `priceFromMinor` at the
  platform's four-decimal scale.
- **The window** — `statementWindowOf` turns the two days into `[from 00:00 UTC, to+1day 00:00 UTC)`,
  half open at the end for the same reason every range in this codebase is: an entry exactly at the
  closing instant belongs to the next period. Both days are whole and UTC, because the platform keeps
  one clock.
- **The order** — `occurred_at desc, id desc`, the order of `0041`'s
  `ledger_entries_statement_idx`. A tie on the instant is broken by the newer id first.
- **The ceiling** — the entry read fetches `MAXIMUM_STATEMENT_ROWS + 1` (10,001). One more than the
  ceiling is the signal the period is wider than a statement, and the answer is `statement_too_long`
  on the `period` field, not a file a person cannot finish reading.
- **The account lookup** — the service reads `ledger_accounts` by `company_id` and
  `account_code = merchant_payable`, and takes **both** a merchant's active and closed payable,
  because a wrong account is closed and a corrected one opened beside it (`0040`'s way) and the
  entries on the closed one are still the balance's history. A merchant with no payable gets a
  header-only CSV: an empty history is a history.
- **The CSV** — `statementCsvOf` writes the header, one record per line, CRLF, and `csvCell` applies
  RFC 4180's four rules (comma, quote or line break → quoted; quote doubled). The file's own name is
  `settlement-statement_<from>_<to>.csv`.
- **The refusals** — `required` (a day the form did not send), `invalid_format` (a day not in the
  form, or a day that is not a day of its month), `period_reversed` (a first day after the last),
  `statement_too_long` (a period wider than the ceiling). Each names its field; the screen words them.

## The gate, in one breath

`services/invoices/settlement-statement-verify.ts`, 69 checks, against a fabricated ledger that
answers the service's two reads the way PostgREST answers: the full statement as exact CSV bytes
(newest first, signs, labels, empty description cell), the two excluded words out of the file, the
other side of the double entry (on the clearing account) out of the file, the other merchant's money
out of the file, the boundary (at-from included, at-to+1day excluded), two payables (closed + active)
both included, a tie on the instant broken by newer id first, 10,000 rows OK / 10,001 refused, a
reversed period, a malformed date, an impossible date, a missing day, the role refusals, the CSV
writer's four escaping rules with the platform's own `readCsv` reading the file back, and source-level
checks on the route (reads the session, no CSRF, no body, `text/csv`, attachment, `no-store`,
`force-dynamic`, no company on any parameter).

## Verification

- **Typecheck**: `npx tsc --noEmit` — 0 errors.
- **Lint**: `npx eslint` on the eight touched files — 0 errors.
- **Build**: `npm run build` — 0 errors, 156 routes (the `/settlements` page is one of them).
- **Gate**: `node services/invoices/settlement-statement-verify.ts` — 69 checks passed.
- **Full chain**: `npm run verify` — exit 0 (audit, structure, env, config, i18n, logger, errors,
  lint, shell, jobs, migrations, estimates, recurring, recurring-service, recurring-job,
  recurring-generation, settlement-statement, typecheck, lint, build).
- **Auth gate**: `node lib/auth/verify.ts` — 2811 checks passed (unchanged: a GET read adds no
  POST/DELETE mutation).

## Next

- **Next STEP**: 126 — Settlement statement export PDF generation (the same statement as a document
  with totals).
- **The next chat must know**: the statement reads `0041`'s `ledger_entries` through
  `appConfig`-style `RestClient.select`, so it needs no database connection to run its gate — the gate
  fabricates the ledger. The payment core (STEPs 127+) is what writes the ledger rows; until then the
  gate is the only place `merchant_payable` entries exist. The PDF (STEP 126) should reuse
  `statementWindowOf`, `STATEMENT_SOURCE_TYPES` and the line mapping, and add the totals row this CSV
  deliberately does not carry.
