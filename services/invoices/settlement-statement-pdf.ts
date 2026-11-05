// path: services/invoices/settlement-statement-pdf.ts
import { priceFromMinor, priceToMinor } from "../products/price.ts";
import {
  type SettlementStatementDependencies,
  type SettlementStatementInput,
  gatherSettlementLines,
} from "./settlement-statement.ts";
import { buildPdfDocument, pdfTextOp } from "./pdf.ts";
import type { StatementLine, StatementPeriod } from "./settlement-statement-fields.ts";

/**
 * Section 17's settlement statement as PDF: the same movements the CSV carries, on pages, with the
 * totals the CSV deliberately leaves off.
 *
 * ## Why the PDF carries totals and the CSV does not
 *
 * A CSV is a file a spreadsheet opens, and a spreadsheet sums a column the moment the merchant points
 * at it - a totals row in the file would be a row the spreadsheet has to skip. A PDF is a document a
 * person reads, and a person reading a statement wants the bottom line on the page: what came in, what
 * went out, and what the balance did. The two files are the same statement in two forms, and each
 * form carries what its reader needs.
 *
 * ## Why it reuses the gather and not the CSV
 *
 * Every rule of the statement - the role, the period, the account, the eight words, the window, the
 * order, the ceiling, the sign - lives in `gatherSettlementLines`, which STEP 125's CSV renderer and
 * this PDF renderer both call. A rule changed in the gather is a rule changed for every file the
 * merchant downloads; a rule duplicated in a renderer is a rule that can drift between them.
 *
 * ## The layout
 *
 * A4, one statement per file, forty rows a page. Every page carries the title, the period and the
 * table header; the last page carries the totals after the rows. The columns are the CSV's columns -
 * date, type, amount, currency, description - with the amounts right-aligned the way a column of
 * numbers is read.
 */

/** The movement count one page carries before the statement runs to another. */
const ROWS_PER_PAGE = 40;
/** The distance between one row's baseline and the next. */
const ROW_SPACING = 14;

/** The page's left margin and the columns, in the points PDF measures in. */
const LEFT = 48;
const AMOUNT_RIGHT_EDGE = 330;
const DATE_X = 48;
const TYPE_X = 140;
const CURRENCY_X = 335;
const DESCRIPTION_X = 390;

/** The totals a statement carries: what came in, what went out, and what the balance did. */
export interface SettlementStatementTotals {
  /** The sum of the credits, in the printed form. */
  readonly credits: string;
  /** The sum of the debits, in the printed form, positive. */
  readonly debits: string;
  /** Credits minus debits, in the printed form, signed. */
  readonly net: string;
}

export interface SettlementStatementPdfResult {
  /** The file, one page per forty movements, ready to send. */
  readonly pdf: Uint8Array;
  /** The movements the file carries, the header not counted. */
  readonly rowCount: number;
  /** The period the file covers, in the days the caller picked. */
  readonly period: StatementPeriod;
  /** The file's own name, with the period on it. */
  readonly filename: string;
  /** The totals the document's last page carries. */
  readonly totals: SettlementStatementTotals;
}

/** One line's signed amount back in minor units, the unit the totals are summed in. */
function amountToMinor(amount: string): bigint {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const minor = priceToMinor(unsigned);

  return minor === null ? 0n : negative ? -minor : minor;
}

/** The three totals of a statement, summed in minor units and printed at the platform's scale. */
function computeTotals(lines: readonly StatementLine[]): SettlementStatementTotals {
  let credits = 0n;
  let debits = 0n;

  for (const line of lines) {
    const minor = amountToMinor(line.amount);

    if (minor >= 0n) {
      credits += minor;
    } else {
      debits += -minor;
    }
  }

  const net = credits - debits;

  return {
    credits: priceFromMinor(credits),
    debits: priceFromMinor(debits),
    net: net >= 0n ? priceFromMinor(net) : `-${priceFromMinor(-net)}`,
  };
}

/**
 * Render one page of the statement as a content stream: the title, the period, the table header, the
 * rows that belong on this page, and - on the last page - the totals.
 */
function renderPage(
  lines: readonly StatementLine[],
  period: StatementPeriod,
  pageIndex: number,
  totalPages: number,
  totals: SettlementStatementTotals,
): string {
  const ops: string[] = [];

  ops.push(pdfTextOp(LEFT, 792, "F2", 15, "Settlement Statement"));
  ops.push(pdfTextOp(LEFT, 778, "F1", 10, `Period: ${period.from} to ${period.to}`));

  // The table header, repeated on every page so a reader who turns to page three knows what the
  // columns are without turning back.
  const headerY = 762;
  ops.push(pdfTextOp(DATE_X, headerY, "F2", 9, "Date"));
  ops.push(pdfTextOp(TYPE_X, headerY, "F2", 9, "Type"));
  ops.push(pdfTextOp(0, headerY, "F2", 9, "Amount", "right", AMOUNT_RIGHT_EDGE));
  ops.push(pdfTextOp(CURRENCY_X, headerY, "F2", 9, "Currency"));
  ops.push(pdfTextOp(DESCRIPTION_X, headerY, "F2", 9, "Description"));

  const start = pageIndex * ROWS_PER_PAGE;
  const end = Math.min(lines.length, start + ROWS_PER_PAGE);
  let y = 748;

  if (start >= lines.length) {
    // An empty statement is still a statement: the page says so in words, and the totals below it
    // carry the zeros a merchant reconciles against.
    ops.push(pdfTextOp(LEFT, y, "F1", 9, "No movements in this period."));
  } else {
    for (let index = start; index < end; index += 1) {
      const line = lines[index] ?? ({} as StatementLine);

      ops.push(pdfTextOp(DATE_X, y, "F1", 9, line.date));
      ops.push(pdfTextOp(TYPE_X, y, "F1", 9, line.label));
      ops.push(pdfTextOp(0, y, "F1", 9, line.amount, "right", AMOUNT_RIGHT_EDGE));
      ops.push(pdfTextOp(CURRENCY_X, y, "F1", 9, line.currency));
      ops.push(pdfTextOp(DESCRIPTION_X, y, "F1", 9, line.description));
      y -= ROW_SPACING;
    }
  }

  // The totals live on the last page, after the rows: a reader who reads to the end sees the balance.
  if (pageIndex === totalPages - 1) {
    y -= ROW_SPACING * 2;
    ops.push(pdfTextOp(TYPE_X, y, "F2", 9, "Total credits"));
    ops.push(pdfTextOp(0, y, "F2", 9, totals.credits, "right", AMOUNT_RIGHT_EDGE));
    y -= ROW_SPACING;
    ops.push(pdfTextOp(TYPE_X, y, "F2", 9, "Total debits"));
    ops.push(pdfTextOp(0, y, "F2", 9, totals.debits, "right", AMOUNT_RIGHT_EDGE));
    y -= ROW_SPACING;
    ops.push(pdfTextOp(TYPE_X, y, "F2", 9, "Net"));
    ops.push(pdfTextOp(0, y, "F2", 9, totals.net, "right", AMOUNT_RIGHT_EDGE));
  }

  ops.push(pdfTextOp(LEFT, 40, "F1", 8, `Page ${pageIndex + 1} of ${totalPages}`));

  return ops.join("\n");
}

/** Split the statement into pages, each a content stream, the last carrying the totals. */
function renderPages(
  lines: readonly StatementLine[],
  period: StatementPeriod,
  totals: SettlementStatementTotals,
): string[] {
  const totalPages = Math.max(1, Math.ceil(lines.length / ROWS_PER_PAGE));
  const pages: string[] = [];

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    pages.push(renderPage(lines, period, pageIndex, totalPages, totals));
  }

  return pages;
}

/**
 * Build the statement as PDF for the actor's company.
 *
 * The gather does every rule; this function renders. The file is the pages; the totals are summed
 * from the same lines the pages carry, so a totals row can never disagree with the rows above it.
 */
export async function buildSettlementStatementPdf(
  input: SettlementStatementInput,
  dependencies: SettlementStatementDependencies,
): Promise<SettlementStatementPdfResult> {
  const { lines, period, rowCount } = await gatherSettlementLines(input, dependencies);
  const totals = computeTotals(lines);
  const pages = renderPages(lines, period, totals);

  return {
    pdf: buildPdfDocument(pages),
    rowCount,
    period,
    filename: `settlement-statement_${period.from}_${period.to}.pdf`,
    totals,
  };
}
