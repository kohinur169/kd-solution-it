// path: docs/handoffs/STEP_180_COMPLETED.md
# STEP 180 — Tax line storage on invoice and payment records and totals view

**Status: COMPLETED**

## STEP

- Number and title: STEP 180 — Tax line storage on invoice and payment records and totals view.
- Category: Sales Tax Collection With TaxCloud, STEPs 176-180, the last STEP of the block. STEP 176 recorded the pages, STEP 177 built the connect flow and the ping, STEP 178 built the switch and the one decision, STEP 179 calculated the tax, and this STEP stores it on the invoice and the payment and shows the totals.
- Depends on: `docs/final/FEATURE_LIST.md` section 7 ("The tax amount appears as its own line on the invoice and is stored on invoice and payment records", "Collected sales tax totals are visible per sub-merchant and platform wide"); STEP 179's `TaxCloudInvoiceTax`; STEP 178's decision vocabulary for the sentence a screen shows when there is no tax line; STEP 023's `migrations/0022_invoices.sql` (`tax_minor`, the derived total trigger, `invoices_total_check`) and `migrations/0023_invoice_items.sql` (the stored line total); STEP 024's `migrations/0037_payments.sql` (`amount_minor`); STEP 012's `public.set_row_metadata()` and the shipment pattern of `0036`.

## Owned paths, and the ones that stay shut

Owned and used: `lib/tax/` plus the append-only migration this block's own feature needs, per `docs/final/STEP_PLAN_250.md:108` and `:119`.

- `migrations/0121_invoice_tax_lines.sql` — new, 253 lines. The `invoice_tax_lines` table, its two indexes, its issued-invoice guard, the payment's `tax_minor` column with its check and its settled-payment guard, and the `(id, company_id)` unique on `invoice_items` a composite foreign key needs.
- `migrations/0121_invoice_tax_lines.down.sql` — new, 42 lines, the exact inverse.
- `lib/tax/taxcloud-tax-line.ts` — new, 982 lines. The rate, the rows, the writer, the payment's share, the store port with an in-memory and a rest adapter, and the audit vocabulary.
- `lib/tax/taxcloud-tax-line-runtime.ts` — new, 25 lines. The production wiring.
- `lib/tax/taxcloud-tax-line-verify.ts` — new, 942 lines, the gate, **243 checks**, eight sections.
- `lib/tax/taxcloud-tax-totals.ts` — new, 446 lines. The per-merchant and platform-wide totals, the money and rate text, and the invoice's four-row view.
- `lib/tax/taxcloud-tax-totals-verify.ts` — new, 446 lines, the gate, **131 checks**, six sections.
- `docs/handoffs/STEP_180_COMPLETED.md` — this file.

Untouched, deliberately: `services/invoices/` and `services/` generally (the writer's own tables are read, and the one call that writes the tax is the collector's, per `0036`'s comment), `components/`, `app/` (the screen is not this block's; see "Not Run"), `package.json`, `config/structure.json`, `lib/payments/` (the payment row is written by its own service; `payments.tax_minor` is the column section 7 asks for), and every shipped migration.

## Database

**`0121`, an append-only migration with its rollback, because section 7 needs storage that does not exist yet.** The inventory was checked first: `invoices.tax_minor` exists in `0022` and `company_transactions.tax_minor` in `0066` is the platform company's own book, not a merchant payment; `invoice_items` has no tax column and its line total is generated, so a tax column there would fight `invoices_total_check`; `payments` has no tax column; `invoice_events` has a closed type vocabulary and a 500 character `detail`, so a breakdown cannot ride there either. The number used is the next unused one, 0121.

| Object | Why it is needed |
|---|---|
| `public.invoice_tax_lines` | One row per invoice line: the taxable amount, the tax, the rate in basis points, the TIC, the currency, the provider and the calculation instant. Its two identities are checks: `tax_minor <= taxable_minor` and one live row per `(invoice_id, line_index)` through a partial unique index. |
| `invoice_tax_lines_guard_issued()` + trigger | A draft's tax may be recalculated; an issued invoice's may not. The guard reads `invoices.status` rather than a copy, and refuses both a rewrite and a removal once the invoice has left `draft`. |
| `payments.tax_minor` + `payments_tax_check` | The part of the invoice's tax a payment collected, bounded by the payment's own amount (`tax_minor <= amount_minor`). |
| `payments_guard_tax_state()` + trigger | Collected money does not move after the money settled: a `settled`, `partially_refunded` or `refunded` payment's tax is frozen. |
| `invoice_items_tenant_key` | A composite foreign key can only point at a unique key, and `0023` carries none on `(id, company_id)`. Added here the way `0105` added `countries_code_unique`. |
| Two indexes | `invoice_tax_lines_line_key` (the one live row per line) and `invoice_tax_lines_company_idx` (`company_id`, `calculated_at desc`), which is the totals query's predicate. |
| RLS + `invoice_tax_lines_default_deny` | Every table in this repository carries its own default-deny policy in the file that creates it. |

**Rollback proof.** `0121_invoice_tax_lines.down.sql` drops the table, the payment column with its check and comment, the two guard functions and their triggers, and the unique key it added to `invoice_items`; it creates nothing and touches no other file's rows. `npm run check:migrations` reads both files and passes (**3528 checks, 121 migrations, 90 tables**), including its static rules: numbering contiguous, forward file transactional and append-only, every created table default-deny, and a rollback that drops exactly the tables its forward file creates.

**A transcript on PostgreSQL is owed.** This environment has no database, so the apply-and-rollback run is not claimed: the migration is asserted from its text and from the static gate, exactly as STEP 121's handoff recorded for `0118`. The three shipped table definitions it alters (`invoice_items`, `payments`, `invoices`) are read from the completed migrations, not guessed.

## Environment

No variable is added. `taxcloud-tax-line-runtime.ts` reads the platform's existing rest client and audit trail and nothing else.

## Packages

None. `package.json` is unchanged.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| The tax is stored on the invoice record | `recordInvoiceTax` writes `invoices.tax_minor` under the version it read, and the database's own trigger recomputes `total = subtotal - discount + tax`, so the writer cannot disagree with `invoices_total_check`. The gate proves the value written, the version the write produces and the total the caller is answered with. |
| The tax appears as its own line | One `invoice_tax_lines` row per line, and the invoice's four-row view gives the tax row its own label, its own amount and its own emphasis. The gate proves one row per line, the row's amount, basis-point rate, TIC, currency, provider and instant. |
| The parts add up to the whole | Three checks: the answer's `totalTaxMinor` equals the invoice's tax, the rows sum to the invoice's tax, and each row's tax is at most what it taxed. The gate proves each refusal by name, and proves that a duplicated line is refused for being duplicated rather than for a later symptom. |
| The tax is stored on the payment record | `recordPaymentTax` writes `payments.tax_minor` as the payment's share of the invoice's tax, and the gate proves the sequence for three part-payments of one invoice: two rounded shares and a final payment that takes the remainder, so the parts are the whole exactly. It also proves a one-unit tax over a three-unit invoice collects nothing on the first two payments and everything on the last, which no rounded share could do. |
| A settled payment's tax cannot be rewritten | The service refuses with a sentence and `payments_guard_tax_state` refuses the same write at the table; the in-memory store refuses it as well, so the rule is proven at all three doors. |
| An issued invoice's tax is not recalculated | The service refuses with "the tax of an invoice that has left draft is a fact and is not recalculated", and `invoice_tax_lines_guard_issued` refuses the row write. The gate reads the migration and proves both sentences are in the schema. |
| A recalculation replaces the breakdown | `invoice_tax_lines_line_key` is unique on `(invoice_id, line_index)` where the row is live; the writer soft-deletes the live rows, inserts the new ones and only then writes the invoice's tax. The gate proves the replacement leaves the old rows as history (four rows stored, two live) and that reading back gives two. |
| A race cannot leave a breakdown without its tax | The invoice write is version guarded. A lost version is `CONFLICT`, writes no audit entry, and the rest adapter compensates by soft-deleting exactly the rows it just inserted; the gate proves the compensation targets `calculated_at = <this attempt>` and the call order (two reads, three writes, the read that proves the version). |
| An unchanged calculation is not a decision | Storing the same answer twice answers `unchanged`, writes no row and audits nothing. Proven by the audit trail's length and the store's live row count. |
| Turning collection off clears the tax | `recordInvoiceTax` with no calculation clears the invoice's tax and its rows, answers `cleared`, and audits `taxcloud.tax_line_cleared` rather than a storing. The gate proves the new total, the empty live set and the action. |
| Totals are visible per sub-merchant and platform wide | `taxCloudTaxTotalsOf` answers one total per merchant and one over all of them, with invoiced, collected and outstanding tax separately; the gate proves the merchants add up to the platform, the ordering (collected first, the merchant id as a tie-break) and the empty report. |
| A return is a period | `taxCloudTaxTotalsInWindowOf` is half open: the start instant is counted, the end instant is not, so two consecutive returns count every instant once. The gate proves a four-row fixture counts two. |
| A report that would be wrong is refused | A mixed currency, a negative amount, more collected than taxed, an instant that is not one, a window that runs backwards and a report longer than five hundred merchants are each refused with the field that is wrong, not coerced. |
| The screen has one sentence for a missing tax line | The view's notice is `taxCloudCollectionDecisionMessageOf(reason)` when STEP 178's decision says collection is off, and a plain sentence otherwise; the gate proves both, and that a collecting merchant reads the plain sentence rather than a refusal. |
| Both widths are described | `TAXCLOUD_TOTALS_LAYOUT` names the desktop's four headings and the phone's two columns with four rows, so a screen cannot invent a fifth figure; the gate proves the two lists describe the same four keys and that each label is short enough for a phone. |

## Security review for this STEP

- **Validation**: every amount is a bigint in minor units and every rate is a whole basis point between zero and 10000; the invoice's own arithmetic is checked before anything is written; identifiers are checked against the platform's id shapes; the TIC is bounded; the currency has a shape and the provider is a closed vocabulary, in the service and in the table.
- **RLS**: `0121` enables row level security and installs `invoice_tax_lines_default_deny` in the same file, so the new table is default-deny like every other; the reads and writes go through the platform's server rest client, and every query is scoped by `company_id`.
- **Audit log entries**: three actions. `taxcloud.tax_line_stored` and `taxcloud.tax_line_cleared` carry the provider key, the currency, the four amounts as digit strings, the line count, the invoice version and the outcome; `taxcloud.payment_tax_stored` carries the invoice and payment ids, the collected tax and the two bounds it was computed from. No credential, no connection and no client address is in any of them, and the gate proves the exact values of the stored entry.
- **Permission checks**: the writer takes the session's actor and writes only that actor's company; a platform account with no company is refused rather than throwing. Which role may edit an invoice is the invoice surface's own rule, and this module does not widen it: it is called from that surface, with that session.
- **Money**: never a float. The rate is read from its decimal digits, the share is integer arithmetic with half away from zero, and the text a screen prints is built by integer division. The gate proves the rate rounding at the half, the share rounding at the half, and that the totals module contains no `Number(`, `parseFloat` or `toFixed`.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/tax/` — clean, no warnings.
- `node lib/tax/taxcloud-tax-line-verify.ts` — `taxcloud tax line gate passed: 243 checks`.
- `node lib/tax/taxcloud-tax-totals-verify.ts` — `taxcloud tax totals gate passed: 131 checks`.
- Both gates under `node --experimental-strip-types` — the same 243 and 131 checks.
- `npm run check:migrations` — **3528 checks, 121 migrations, 90 tables**.
- `npm run check:structure` — 17 directories, 14 root files, **598** source files.
- `npm run build` — clean, every route compiled.
- `npm run verify` — **exit 0**: audit **3337** checks, structure 598 source files, migrations 3528, lint **77** checks.
- Gate mutation proof: **43 of 43** mutations were caught (`/tmp/mutate_tax180.py`), each applied to a copy of one module, run against the honest gates and restored in the same command. They broke: the rate rounding at the half; a negative rate; an issued invoice's tax recalculated; a total that is not its parts; a currency other than the dollar; a version of zero; an instant of zero; two lines sharing a key; a tax above what it taxed; an answer for another invoice; an answer whose total is not the invoice's; an answer with the wrong line count; line amounts that do not add up; a missing TIC stored as zero; a rate never stored; an unchanged calculation written again; a lost version written anyway; a clearing audited as a storing; the audit entry naming the wrong version; a rounded final share instead of the remainder; a floored share; an overpayment collecting tax; more collected than taxed; a settled payment's tax written; a payment of another amount accepted; the adapter leaving its rows behind on a conflict; the adapter writing without a version guard; the store writing a settled payment; the tax row renamed; a phone printing three rows; nothing outstanding; a mixed currency summed; more collected than taxed summed; a truncated report; a period counting its closing instant; the cents a tenth of their value; a negative amount losing its sign; a whole percent printing decimals; no row emphasised; the sentence ignoring the decision; the lines in the wrong order; lines that do not add up shown; a payment above the invoice shown.

## Not Run / Open

- **No route and no screen.** `app/` and `components/` are not this block's, and the block's precedent since STEP 170 is a library module with a gate. The deliverables a screen needs are here: `TaxCloudInvoiceTotalsView` (four rows with text, per-line rates, the notice, the paid and outstanding figures) and `TAXCLOUD_TOTALS_LAYOUT` for the two widths. The settings panel of STEP 178 and this totals block belong on the same page, and that page needs a STEP that owns `app/`.
- **Who calls the writer.** `services/invoices/` belongs to its own STEPs, so nothing there is edited. The integration is one call after STEP 179's calculation: `recordInvoiceTax({ actor, invoice, lines, tax }, getTaxCloudTaxLineRuntime())` on a draft, and `recordPaymentTax(...)` from the payment capture path that owns `payments`. Both are documented above and proven against a reference store; the caller's own permission rule stays its own.
- **The platform-wide view is a read model, not a screen.** Section 7's "platform wide" total is answered by `taxCloudTaxTotalsOf` over rows the caller reads; the office surface that renders it belongs to `app/(admin)/`, which this block does not own.
- **A refund moves, and does not un-collect, the tax.** The share rule handles payments; attributing a refund back out of a settled payment's tax belongs to the refund STEPs (191-199), which own `refunds` and the payment sync. This STEP leaves them the column and the bound they need.
- **No rate table and no jurisdiction table.** TaxCloud answers the rate and section 7 says the platform builds no tax engine of its own; `rate_bp` is information, and money is never derived from it.
- **The estimation records do not carry a tax line.** `0025` has `tax_minor` and section 7 speaks of invoices; an estimate's tax belongs to the estimate STEPs, and this table is invoice-scoped by a composite foreign key so it cannot hold one by accident.
