// path: lib/tax/taxcloud-tax-totals.ts
import { AppError } from "../errors/app-error.ts";
import { deepFreeze } from "../utils/freeze.ts";
import { MINOR_PER_UNIT } from "../payments/money.ts";
import type { TaxCloudTaxLineRow } from "./taxcloud-tax-line.ts";
import { TAXCLOUD_RATE_MAXIMUM_BP, TAXCLOUD_TAX_LINE_CURRENCY } from "./taxcloud-tax-line.ts";
import type { TaxCloudCollectionDecision } from "./taxcloud-collection.ts";
import { taxCloudCollectionDecisionMessageOf } from "./taxcloud-collection.ts";

/**
 * The totals view of FEATURE_LIST section 7: "collected sales tax totals are visible per sub-merchant
 * and platform wide", and the tax line the invoice screen shows.
 *
 * ## Two questions, two shapes
 *
 * A merchant asking "what did I collect" and a platform asking "what did we collect" are the same
 * arithmetic over one more grouping, so `taxCloudTaxTotalsOf` answers both: a total per merchant and a
 * total over the merchants. The difference between *invoiced* and *collected* tax is the whole point of
 * the report - an invoice says what a client was charged, a settled payment says what the merchant
 * actually received - so the two are summed apart and the remainder is named.
 *
 * ## Why the sums are refused rather than coerced
 *
 * Every row is a bigint in minor units, so the arithmetic is exact. What is not exact by nature is a
 * list that mixes currencies, carries a negative amount, or claims more collected tax than was invoiced.
 * Each of those is refused with the field that is wrong: a report that silently adds dollars to dirhams
 * is worse than no report, because it looks right.
 *
 * ## The invoice's own view
 *
 * `taxCloudInvoiceTotalsViewOf` is what the invoice screen and the PDF read: four rows that add up, one
 * row per line with its rate, and a sentence when there is no tax line, taken from STEP 178's decision
 * vocabulary so the screen and the settings panel cannot say different things. The labels are the ones
 * a merchant reads; the amounts stay in minor units, because formatting money is the screen's business
 * and `taxCloudMoneyTextOf` is here for a screen that wants the platform's spelling rather than its own.
 */

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The four rows every invoice totals block shows, in the order a reader expects them. */
export const TAXCLOUD_TOTALS_ROW_KEYS = deepFreeze(["subtotal", "discount", "tax", "total"] as const);

export type TaxCloudTotalsRowKey = (typeof TAXCLOUD_TOTALS_ROW_KEYS)[number];

/** The label of each row, one spelling for the screen, the PDF and the report. */
export const TAXCLOUD_TOTALS_ROW_LABELS: Readonly<Record<TaxCloudTotalsRowKey, string>> = deepFreeze({
  subtotal: "Subtotal",
  discount: "Discount",
  tax: "Sales tax",
  total: "Total",
});

/** The sentence a screen shows instead of a tax line when there is none, other than a decision's own. */
export const TAXCLOUD_NO_TAX_SENTENCE = "No sales tax was calculated for this invoice.";

/** The most companies one totals answer lists, so a query cannot ask a screen to render a million rows. */
export const TAXCLOUD_TOTALS_MAXIMUM_COMPANIES = 500;

/* -------------------------------------------------------------------------------------------------
 * Money text
 * ---------------------------------------------------------------------------------------------- */

/**
 * Money as the platform spells it: the currency, then the amount with two decimals and grouped
 * thousands.
 *
 * The conversion is from minor units by integer division, never from a float, and the fraction is the
 * two decimals a screen shows even though the platform stores four - a tax report reads "USD 1,234.56"
 * and never "USD 1234.5600". The digits beyond the second are kept in the arithmetic and dropped only
 * here, at the point where a human reads them.
 */
export function taxCloudMoneyTextOf(currency: string, minorUnits: bigint): string {
  if (/^[A-Z]{3}$/u.test(currency) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "currency", rule: "a currency is three upper case letters" }],
    });
  }

  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const whole = magnitude / MINOR_PER_UNIT;
  const fraction = (magnitude % MINOR_PER_UNIT) / 100n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const spoken = `${grouped}.${fraction.toString().padStart(2, "0")}`;

  return negative ? `-${currency} ${spoken}` : `${currency} ${spoken}`;
}

/** A basis point rate as the percent a merchant reads: `812` is `8.12%`, `813` is `8.13%`. */
export function taxCloudRateLabelOf(rateBp: number): string {
  if (Number.isSafeInteger(rateBp) === false || rateBp < 0 || rateBp > TAXCLOUD_RATE_MAXIMUM_BP) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "rateBp", rule: "a rate is whole basis points between zero and 10000" }],
    });
  }

  const whole = Math.trunc(rateBp / 100);
  const fraction = rateBp % 100;

  if (fraction === 0) return `${String(whole)}%`;

  return `${String(whole)}.${String(fraction).padStart(2, "0").replace(/0$/u, "")}%`;
}

/* -------------------------------------------------------------------------------------------------
 * The totals
 * ---------------------------------------------------------------------------------------------- */

/** One invoice's row in the report: what it was taxed and what its payments have collected. */
export interface TaxCloudTaxTotalRow {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly currency: string;
  readonly taxMinor: bigint;
  readonly collectedTaxMinor: bigint;
  /** When the tax was calculated, which is the instant a period filter reads. */
  readonly calculatedAtEpochMs: number;
}

/** The totals of one merchant. */
export interface TaxCloudCompanyTaxTotals {
  readonly companyId: string;
  readonly invoiceCount: number;
  readonly taxMinor: bigint;
  readonly collectedTaxMinor: bigint;
  readonly outstandingTaxMinor: bigint;
}

/** The totals: one currency, every merchant, and the platform's own sum. */
export interface TaxCloudTaxTotals {
  readonly currency: string;
  readonly invoiceCount: number;
  readonly companyCount: number;
  readonly taxMinor: bigint;
  readonly collectedTaxMinor: bigint;
  readonly outstandingTaxMinor: bigint;
  readonly byCompany: readonly TaxCloudCompanyTaxTotals[];
}

function totalsProblemOf(row: TaxCloudTaxTotalRow, currency: string): string | null {
  if (row.currency !== currency) return "a tax total mixes two currencies";
  if (row.taxMinor < 0n) return "a tax total carries a negative amount";
  if (row.collectedTaxMinor < 0n) return "a collected total carries a negative amount";
  if (row.collectedTaxMinor > row.taxMinor) return "a collected total is larger than the tax it collected";
  if (Number.isSafeInteger(row.calculatedAtEpochMs) === false || row.calculatedAtEpochMs <= 0) {
    return "a row's calculation instant is not one this platform records";
  }

  return null;
}

/**
 * Sum the tax of many invoices, per merchant and over all of them.
 *
 * The rows are read in the order they are given and the merchants are listed by their collected tax,
 * largest first, with the identifier as the tie-break so two runs of the same data read the same way. A
 * list longer than `TAXCLOUD_TOTALS_MAXIMUM_COMPANIES` merchants is refused rather than truncated: a
 * report that quietly drops merchants is a report that is wrong once a month.
 */
export function taxCloudTaxTotalsOf(
  rows: readonly TaxCloudTaxTotalRow[],
  options: { readonly currency?: string } = {},
): TaxCloudTaxTotals {
  const currency = options.currency ?? TAXCLOUD_TAX_LINE_CURRENCY;

  if (/^[A-Z]{3}$/u.test(currency) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "currency", rule: "a currency is three upper case letters" }],
    });
  }

  const byCompany = new Map<string, { invoiceCount: number; taxMinor: bigint; collectedTaxMinor: bigint }>();
  let taxMinor = 0n;
  let collectedTaxMinor = 0n;

  for (const row of rows) {
    const problem = totalsProblemOf(row, currency);

    if (problem !== null) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "rows", rule: problem }] });
    }

    const current = byCompany.get(row.companyId) ?? { invoiceCount: 0, taxMinor: 0n, collectedTaxMinor: 0n };

    byCompany.set(row.companyId, {
      invoiceCount: current.invoiceCount + 1,
      taxMinor: current.taxMinor + row.taxMinor,
      collectedTaxMinor: current.collectedTaxMinor + row.collectedTaxMinor,
    });
    taxMinor += row.taxMinor;
    collectedTaxMinor += row.collectedTaxMinor;
  }

  if (byCompany.size > TAXCLOUD_TOTALS_MAXIMUM_COMPANIES) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "rows", rule: "a totals query lists at most 500 merchants" }],
    });
  }

  const companies = [...byCompany.entries()]
    .map(([companyId, totals]) => ({
      companyId,
      invoiceCount: totals.invoiceCount,
      taxMinor: totals.taxMinor,
      collectedTaxMinor: totals.collectedTaxMinor,
      outstandingTaxMinor: totals.taxMinor - totals.collectedTaxMinor,
    }))
    .sort((left, right) => {
      if (left.collectedTaxMinor !== right.collectedTaxMinor) {
        return left.collectedTaxMinor > right.collectedTaxMinor ? -1 : 1;
      }

      return left.companyId < right.companyId ? -1 : left.companyId > right.companyId ? 1 : 0;
    });

  return {
    currency,
    invoiceCount: rows.length,
    companyCount: byCompany.size,
    taxMinor,
    collectedTaxMinor,
    outstandingTaxMinor: taxMinor - collectedTaxMinor,
    byCompany: companies,
  };
}

/**
 * The same totals over one period.
 *
 * A tax return is a period, so the window is half open - from the start instant included to the end
 * instant excluded - which is the only definition under which two consecutive windows never count an
 * instant twice and together count every instant once.
 */
export function taxCloudTaxTotalsInWindowOf(
  rows: readonly TaxCloudTaxTotalRow[],
  window: { readonly fromEpochMs: number; readonly toEpochMs: number },
  options: { readonly currency?: string } = {},
): TaxCloudTaxTotals {
  if (Number.isSafeInteger(window.fromEpochMs) === false || Number.isSafeInteger(window.toEpochMs) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "window", rule: "a window is two whole instants in milliseconds" }],
    });
  }

  if (window.fromEpochMs >= window.toEpochMs) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "window", rule: "a window ends after it starts" }],
    });
  }

  return taxCloudTaxTotalsOf(
    rows.filter(
      (row) => row.calculatedAtEpochMs >= window.fromEpochMs && row.calculatedAtEpochMs < window.toEpochMs,
    ),
    options,
  );
}

/* -------------------------------------------------------------------------------------------------
 * The invoice's view
 * ---------------------------------------------------------------------------------------------- */

/** One row of the invoice's totals block. */
export interface TaxCloudInvoiceTotalsRow {
  readonly key: TaxCloudTotalsRowKey;
  readonly label: string;
  readonly amountMinor: bigint;
  readonly amountText: string;
  /** The total is the row a screen emphasises; the tax is the row that appears because section 7 asks. */
  readonly emphasis: "none" | "tax" | "total";
}

/** One line of the breakdown a screen renders under the totals. */
export interface TaxCloudInvoiceTotalsLine {
  readonly invoiceItemId: string;
  readonly index: number;
  readonly taxableMinor: bigint;
  readonly taxMinor: bigint;
  readonly rateBp: number;
  readonly rateLabel: string;
}

/** What a screen shows for one invoice. */
export interface TaxCloudInvoiceTotalsView {
  readonly invoiceId: string;
  readonly currency: string;
  readonly rows: readonly TaxCloudInvoiceTotalsRow[];
  readonly lines: readonly TaxCloudInvoiceTotalsLine[];
  /** True when a tax line belongs on the document; false when the sentence replaces it. */
  readonly taxLineShown: boolean;
  /** The sentence a screen shows when there is no tax line, or null when the line is shown. */
  readonly notice: string | null;
  /** What the client still owes, in minor units, when a payment was supplied. */
  readonly paidMinor: bigint | null;
  readonly collectedTaxMinor: bigint | null;
  readonly outstandingMinor: bigint | null;
}

export interface TaxCloudInvoiceTotalsViewInput {
  readonly invoice: {
    readonly invoiceId: string;
    readonly currency: string;
    readonly subtotalMinor: bigint;
    readonly discountMinor: bigint;
    readonly taxMinor: bigint;
    readonly totalMinor: bigint;
  };
  readonly lines: readonly TaxCloudTaxLineRow[];
  /** STEP 178's decision for this transaction, when the caller has one. */
  readonly decision?: TaxCloudCollectionDecision | null;
  /** What has been paid and collected, when the caller wants the outstanding figures. */
  readonly payment?: { readonly paidMinor: bigint; readonly collectedTaxMinor: bigint } | null;
}

/**
 * The invoice's totals block, or the reason it cannot be shown.
 *
 * The four rows are computed from the invoice and checked against each other before they are built: the
 * lines must add up to the tax, the tax must be the one the invoice carries, and the total must be
 * `subtotal - discount + tax`. A screen that received a set of numbers which do not add up would print
 * them, and a client would read an invoice whose parts do not make its total.
 */
export function taxCloudInvoiceTotalsViewOf(
  input: TaxCloudInvoiceTotalsViewInput,
): { readonly view: TaxCloudInvoiceTotalsView } | { readonly reason: string } {
  const { invoice } = input;

  if (/^[A-Z]{3}$/u.test(invoice.currency) === false) return { reason: "the invoice currency is three upper case letters" };
  if (invoice.subtotalMinor < 0n) return { reason: "the invoice subtotal is not negative" };
  if (invoice.discountMinor < 0n) return { reason: "the invoice discount is not negative" };
  if (invoice.taxMinor < 0n) return { reason: "the invoice tax is not negative" };
  if (invoice.discountMinor > invoice.subtotalMinor) return { reason: "the invoice discount is at most its subtotal" };
  if (invoice.totalMinor !== invoice.subtotalMinor - invoice.discountMinor + invoice.taxMinor) {
    return { reason: "the invoice total is not its subtotal less its discount plus its tax" };
  }

  let summedTaxMinor = 0n;

  for (const line of input.lines) {
    if (line.invoiceId !== invoice.invoiceId) return { reason: "a tax line belongs to another invoice" };
    if (line.taxMinor < 0n) return { reason: "a tax line is not negative" };
    if (line.taxMinor > line.taxableMinor) return { reason: "a tax line is above the amount it taxed" };
    if (Number.isSafeInteger(line.rateBp) === false || line.rateBp < 0 || line.rateBp > TAXCLOUD_RATE_MAXIMUM_BP) {
      return { reason: "a tax line's rate is whole basis points between zero and 10000" };
    }

    summedTaxMinor += line.taxMinor;
  }

  if (input.lines.length > 0 && summedTaxMinor !== invoice.taxMinor) {
    return { reason: "the tax lines do not add up to the invoice's tax" };
  }

  if (input.lines.length === 0 && invoice.taxMinor > 0n) {
    return { reason: "an invoice with tax but no tax line has no breakdown to show" };
  }

  const payment = input.payment ?? null;

  if (payment !== null) {
    if (payment.paidMinor < 0n || payment.paidMinor > invoice.totalMinor) return { reason: "the paid amount is between zero and the invoice total" };
    if (payment.collectedTaxMinor < 0n || payment.collectedTaxMinor > invoice.taxMinor) {
      return { reason: "the collected tax is between zero and the invoice tax" };
    }
  }

  const rows: readonly TaxCloudInvoiceTotalsRow[] = TAXCLOUD_TOTALS_ROW_KEYS.map((key) => {
    const amountMinor =
      key === "subtotal"
        ? invoice.subtotalMinor
        : key === "discount"
          ? invoice.discountMinor
          : key === "tax"
            ? invoice.taxMinor
            : invoice.totalMinor;

    return {
      key,
      label: TAXCLOUD_TOTALS_ROW_LABELS[key],
      amountMinor,
      amountText: taxCloudMoneyTextOf(invoice.currency, amountMinor),
      emphasis: key === "total" ? "total" : key === "tax" ? "tax" : "none",
    };
  });
  const taxLineShown = invoice.taxMinor > 0n;
  const decision = input.decision ?? null;

  return {
    view: {
      invoiceId: invoice.invoiceId,
      currency: invoice.currency,
      rows,
      lines: input.lines
        .slice()
        .sort((left, right) => left.lineIndex - right.lineIndex)
        .map((line) => ({
          invoiceItemId: line.invoiceItemId,
          index: line.lineIndex,
          taxableMinor: line.taxableMinor,
          taxMinor: line.taxMinor,
          rateBp: line.rateBp,
          rateLabel: taxCloudRateLabelOf(line.rateBp),
        })),
      taxLineShown,
      notice: taxLineShown
        ? null
        : decision !== null && decision.collect === false
          ? taxCloudCollectionDecisionMessageOf(decision.reason)
          : TAXCLOUD_NO_TAX_SENTENCE,
      paidMinor: payment === null ? null : payment.paidMinor,
      collectedTaxMinor: payment === null ? null : payment.collectedTaxMinor,
      outstandingMinor: payment === null ? null : invoice.totalMinor - payment.paidMinor,
    },
  };
}

/** The totals as a screen's two layouts read them: one table on a desktop, one row per figure on a phone. */
export interface TaxCloudTotalsLayout {
  /** The four headings of the desktop table, in reading order. */
  readonly desktopColumns: readonly string[];
  /** The two columns of a phone's row: the figure's name on the left, its amount on the right. */
  readonly mobileColumns: readonly string[];
  /** How many rows the phone's layout prints, which is one per figure rather than one per table. */
  readonly mobileRowCount: number;
}

/**
 * The columns of the totals block at both widths.
 *
 * A desktop shows the four figures in one table; a phone has no room for four columns, so each figure
 * becomes its own row with its label on the left and its amount on the right. The names are the labels
 * above, so a screen cannot invent a fifth heading, and the gate proves the two lists describe the same
 * four rows.
 */
export const TAXCLOUD_TOTALS_LAYOUT: TaxCloudTotalsLayout = deepFreeze({
  desktopColumns: [
    TAXCLOUD_TOTALS_ROW_LABELS.subtotal,
    TAXCLOUD_TOTALS_ROW_LABELS.discount,
    TAXCLOUD_TOTALS_ROW_LABELS.tax,
    TAXCLOUD_TOTALS_ROW_LABELS.total,
  ],
  mobileColumns: ["label", "amount"],
  mobileRowCount: TAXCLOUD_TOTALS_ROW_KEYS.length,
});
