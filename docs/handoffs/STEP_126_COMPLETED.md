# STEP 126 — Settlement statement export PDF generation

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_125_COMPLETED.md`.

## What this STEP is, in one paragraph

The same settlement statement STEP 125 rendered as CSV, rendered as a PDF document: the same eight
movements, newest first, on A4 pages, with the three totals the CSV deliberately leaves off. The
merchant picks a first day and a last day, and downloads a file that opens in any viewer — a document
a person reads, not a file a spreadsheet sums. The PDF carries what its reader needs and the CSV
does not: a totals block (total credits, total debits, net) on the last page, so a merchant who reads
to the end sees the bottom line without reaching for a calculator.

## What it is not

- **It is not a second statement.** Every rule — the role, the period, the account, the eight words,
  the window, the order, the ceiling, the sign — lives in `gatherSettlementLines`, which STEP 125's
  CSV renderer and this PDF renderer both call. The PDF reads the statement through the gather; it
  does not re-read the ledger. A rule changed in the gather is a rule changed for every file the
  merchant downloads.
- **It is not a PDF library.** The platform carries four dependencies and `MASTER_PROMPT` makes
  `package.json` integrator-owned. A PDF library is a package; a statement is a table of text, and
  PDF is a text-addressable format, so `services/invoices/pdf.ts` writes it by hand: standard
  Helvetica (built in, no embedding), a byte buffer with exact offsets, an xref a reader resolves.
- **It is not the invoice PDF.** `app/api/invoices/[id]/pdf/download/route.ts` renders an invoice
  from stored bytes; this STEP renders a settlement statement from the ledger. Both are PDFs; neither
  is the other's source.
- **It does not need a migration.** The ledger tables are STEP 125's; the PDF is a rendering of the
  same lines. Sub-step 3 was "if any", and it was not.
- **It does not write the ledger or the audit log.** The statement is a read of an append-only
  history; there is nothing to lock, guard or re-read, and a read is not a mutation.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §17, MASTER_PROMPT rules, STEP 125 handoff | — | — |
| 2 | Confirm owned paths | `services/invoices/*` (106-126), the settlements API area, the settlements dashboard area | — |
| 3 | Database part | **none needed** — `0040`/`0041` already carry it | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `buildSettlementStatementPdf` in `settlement-statement-pdf.ts`; `gatherSettlementLines` extracted from the CSV service as the shared read; `pdf.ts` the byte-level writer | settlement-statement-pdf gate |
| 5 | API route | `app/api/settlements/statements/route.ts` gained `format=pdf` (one endpoint, one auth path) | gate + auth gate |
| 6 | UI | "Download PDF" button beside "Download CSV" in `settlement-statement-panel.tsx`; i18n key | build 0 (156 routes) |
| 7 | Security | the `owner` role, the tenant scope of every read, the 10,000-row ceiling, no audit (read, not mutation), the response body backed by its own `ArrayBuffer` | auth **2811 checks** (unchanged) |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The gather is shared** — `gatherSettlementLines` in `settlement-statement.ts` does every rule and
  returns `{ lines, period, rowCount }`. `buildSettlementStatement` (CSV) and `buildSettlementStatementPdf`
  (PDF) both call it. The PDF renderer imports the gather; it does not re-implement the read.
- **The totals** — `computeTotals` in `settlement-statement-pdf.ts` sums the same lines the pages
  carry, in minor units, and prints at the platform's four-decimal scale: `credits` (sum of positive
  amounts), `debits` (sum of absolute negative amounts), `net` (credits − debits, signed). A totals
  row can never disagree with the rows above it because it is summed from those rows.
- **The layout** — A4 (595 × 842 pt), forty rows a page, every page carrying the title, the period
  and the table header, the last page carrying the totals after the rows. Columns are the CSV's
  columns (date, type, amount, currency, description) with amounts right-aligned.
- **The writer** — `pdf.ts` builds a byte buffer, records each object's offset, and writes an xref
  the reader resolves. `/Length` of every stream is the content's exact byte count. Standard Helvetica
  and Helvetica-Bold, no embedding.
- **The escaping** — `pdfEscape` applies PDF's literal-string rules: backslash, then the two
  parentheses. `extractPdfText` reverses them, so the gate reads a statement back out of its own PDF.
- **The refusals** — the same four the CSV answers (`required`, `invalid_format`, `period_reversed`,
  `statement_too_long`), because the gather judges the period before any renderer runs.

## The gate, in one breath

`services/invoices/settlement-statement-pdf-verify.ts`, 56 checks, against a fabricated ledger: the
PDF is a PDF a reader can open (header, xref offsets, `/Length`), it uses standard Helvetica and
embeds no font file; the text reads back the title, the period, the eight movements newest first, the
three totals, and the page count; the totals are checked against arithmetic on a known world; a
forty-five movement statement runs to exactly two pages; an empty statement says so in words and
carries three zero totals; a merchant with no payable reads an empty statement; the ceiling is
refused the same way as the CSV; the three PDF-special characters escape and read back; the roles
refuse; and source checks prove the renderer reads the gather, the writer knows nothing of the
ledger, and the route answers `format=pdf` with `application/pdf` while keeping the CSV's own type.

## Verification

- **Typecheck**: `npx tsc --noEmit` — 0 errors.
- **Lint**: `npx eslint` on the eight touched files — 0 errors.
- **Build**: `npm run build` — 0 errors, 156 routes.
- **Gate**: `node services/invoices/settlement-statement-pdf-verify.ts` — 56 checks passed.
- **STEP 125 gate re-run**: `node services/invoices/settlement-statement-verify.ts` — 69 checks
  passed (the route change did not move the CSV's rules).
- **Full chain**: `npm run verify` — exit 0 (audit, structure, env, config, i18n, logger, errors,
  lint, shell, jobs, migrations, estimates, recurring, recurring-service, recurring-job,
  recurring-generation, settlement-statement, settlement-statement-pdf, typecheck, lint, build).
- **Auth gate**: `node lib/auth/verify.ts` — 2811 checks passed (unchanged: a GET read adds no
  POST/DELETE mutation).

## Next

- **Next STEP**: 127 — Money value handling with decimal library and currency guard (the payment
  core's first STEP).
- **The next chat must know**: the PDF writer (`services/invoices/pdf.ts`) is a generic document
  primitive — text on A4 pages, standard fonts, byte-exact xref — and knows nothing of the ledger.
  Any later STEP that renders a document (an invoice PDF, a tax report) can reuse it; if a document
  needs images, embedded fonts, or vector graphics, that is a different writer and a package request
  in that STEP's handoff. The statement's rules all live in `gatherSettlementLines`; a STEP that
  changes what a statement shows (a new movement type, a different window) changes the gather and
  both files follow. The payment core (STEPs 127+) is what writes the ledger rows; until then the
  gates are the only place `merchant_payable` entries exist.
