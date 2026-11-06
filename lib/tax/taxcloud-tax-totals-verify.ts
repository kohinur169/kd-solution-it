// path: lib/tax/taxcloud-tax-totals-verify.ts

/**
 * The gate for the totals view.
 *
 * Run directly, because the TaxCloud block owns `lib/tax/` and not `package.json`:
 *
 *   node lib/tax/taxcloud-tax-totals-verify.ts
 *
 * Six sections: the labels and the two layouts, money as a screen spells it, the rate label, the totals
 * per merchant and platform wide, the invoice's own view, and the source.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import { taxCloudCollectionDecisionMessageOf } from "./taxcloud-collection.ts";
import type { TaxCloudCollectionDecision } from "./taxcloud-collection.ts";
import type { TaxCloudTaxLineRow } from "./taxcloud-tax-line.ts";
import {
  TAXCLOUD_NO_TAX_SENTENCE,
  TAXCLOUD_TOTALS_LAYOUT,
  TAXCLOUD_TOTALS_MAXIMUM_COMPANIES,
  TAXCLOUD_TOTALS_ROW_KEYS,
  TAXCLOUD_TOTALS_ROW_LABELS,
  taxCloudInvoiceTotalsViewOf,
  taxCloudMoneyTextOf,
  taxCloudRateLabelOf,
  taxCloudTaxTotalsInWindowOf,
  taxCloudTaxTotalsOf,
} from "./taxcloud-tax-totals.ts";
import type { TaxCloudTaxTotalRow } from "./taxcloud-tax-totals.ts";

/* ---- the checking harness ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_782_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company_kd_tax_totals_a";
const OTHER_COMPANY = "company_kd_tax_totals_b";
const THIRD_COMPANY = "company_kd_tax_totals_c";
const INVOICE_ID = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const LINE_ONE = "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9a0";
const LINE_TWO = "3c4d5e6f-7081-4293-a4b5-c6d7e8f9a0b1";

function rowOf(patch: Partial<TaxCloudTaxTotalRow> = {}): TaxCloudTaxTotalRow {
  return {
    companyId: COMPANY,
    invoiceId: INVOICE_ID,
    currency: "USD",
    taxMinor: 21_000n,
    collectedTaxMinor: 13_000n,
    calculatedAtEpochMs: NOW - DAY_MS,
    ...patch,
  };
}

function lineOf(patch: Partial<TaxCloudTaxLineRow> = {}): TaxCloudTaxLineRow {
  return {
    companyId: COMPANY,
    invoiceId: INVOICE_ID,
    invoiceItemId: LINE_ONE,
    lineIndex: 0,
    tic: null,
    taxableMinor: 161_250n,
    taxMinor: 13_000n,
    rateBp: 813,
    currency: "USD",
    providerKey: "taxcloud",
    calculatedAtEpochMs: NOW,
    ...patch,
  };
}

function invoiceOf(patch: Partial<{ subtotalMinor: bigint; discountMinor: bigint; taxMinor: bigint; totalMinor: bigint; currency: string }> = {}): {
  readonly invoiceId: string;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
} {
  return {
    invoiceId: INVOICE_ID,
    currency: "USD",
    subtotalMinor: 261_250n,
    discountMinor: 0n,
    taxMinor: 21_000n,
    totalMinor: 282_250n,
    ...patch,
  };
}

/* ---- section 1: the labels and the two layouts ---- */

function checkLabels(): void {
  expectEqual(TAXCLOUD_TOTALS_ROW_KEYS.join(","), "subtotal,discount,tax,total", "four rows, in the order a reader expects");
  expectEqual(TAXCLOUD_TOTALS_ROW_LABELS.subtotal, "Subtotal", "the first row is named");
  expectEqual(TAXCLOUD_TOTALS_ROW_LABELS.discount, "Discount", "and the second");
  expectEqual(TAXCLOUD_TOTALS_ROW_LABELS.tax, "Sales tax", "and the tax row, which is section 7's own line");
  expectEqual(TAXCLOUD_TOTALS_ROW_LABELS.total, "Total", "and the total");
  expectEqual(TAXCLOUD_TOTALS_LAYOUT.desktopColumns.join(","), "Subtotal,Discount,Sales tax,Total", "a desktop shows the four headings");
  expectEqual(TAXCLOUD_TOTALS_LAYOUT.mobileColumns.join(","), "label,amount", "a phone shows a label and an amount");
  expectEqual(TAXCLOUD_TOTALS_LAYOUT.mobileRowCount, 4, "one row per figure on a phone");
  expectEqual(TAXCLOUD_TOTALS_LAYOUT.mobileRowCount, TAXCLOUD_TOTALS_ROW_KEYS.length, "the two layouts describe the same four figures");
  expectEqual(TAXCLOUD_TOTALS_MAXIMUM_COMPANIES, 500, "a report lists at most five hundred merchants");
  expectEqual(TAXCLOUD_NO_TAX_SENTENCE, "No sales tax was calculated for this invoice.", "the sentence for an invoice with no tax");
  expectEqual(TAXCLOUD_NO_TAX_SENTENCE.endsWith("."), true, "and it is a sentence");

  for (const key of TAXCLOUD_TOTALS_ROW_KEYS) {
    const label = TAXCLOUD_TOTALS_ROW_LABELS[key];

    expect(label.length > 0 && label.length <= 40, `the ${key} label fits a screen`);
    expect(label.trim() === label, `the ${key} label has no stray space`);
  }
}

/* ---- section 2: money as a screen spells it ---- */

function checkMoneyText(): void {
  expectEqual(taxCloudMoneyTextOf("USD", 0n), "USD 0.00", "no money is zero and two decimals");
  expectEqual(taxCloudMoneyTextOf("USD", 123_400n), "USD 12.34", "twelve dollars and thirty four cents");
  expectEqual(taxCloudMoneyTextOf("USD", 1_000_000n), "USD 100.00", "one hundred dollars");
  expectEqual(taxCloudMoneyTextOf("USD", 123_456_700n), "USD 12,345.67", "thousands are grouped");
  expectEqual(taxCloudMoneyTextOf("USD", 100_000_000n), "USD 10,000.00", "ten thousand is grouped once");
  expectEqual(taxCloudMoneyTextOf("USD", 123_456_789n), "USD 12,345.67", "the third and fourth decimals are kept in the arithmetic and not printed");
  expectEqual(taxCloudMoneyTextOf("USD", 5n), "USD 0.00", "a fraction of a cent prints as no cents");
  expectEqual(taxCloudMoneyTextOf("USD", -123_400n), "-USD 12.34", "a negative amount carries its sign");
  expectEqual(taxCloudMoneyTextOf("EUR", 1_000_000n), "EUR 100.00", "another currency prints the same way");
  expectEqual(errorCodeOf(() => taxCloudMoneyTextOf("usd", 1n)), "VALIDATION_FAILED", "a currency in lower case is refused");
  expectEqual(errorCodeOf(() => taxCloudMoneyTextOf("US", 1n)), "VALIDATION_FAILED", "and one that is two letters");
}

/* ---- section 3: the rate label ---- */

function checkRateLabel(): void {
  expectEqual(taxCloudRateLabelOf(0), "0%", "no rate is zero percent");
  expectEqual(taxCloudRateLabelOf(800), "8%", "a whole percent has no decimals");
  expectEqual(taxCloudRateLabelOf(813), "8.13%", "a third of a percent is two decimals");
  expectEqual(taxCloudRateLabelOf(812), "8.12%", "and so is another");
  expectEqual(taxCloudRateLabelOf(850), "8.5%", "a trailing zero is dropped");
  expectEqual(taxCloudRateLabelOf(805), "8.05%", "a leading zero is kept");
  expectEqual(taxCloudRateLabelOf(10_000), "100%", "the ceiling reads as one hundred percent");
  expectEqual(taxCloudRateLabelOf(1), "0.01%", "one basis point is a hundredth of a percent");
  expectEqual(errorCodeOf(() => taxCloudRateLabelOf(-1)), "VALIDATION_FAILED", "a negative rate is refused");
  expectEqual(errorCodeOf(() => taxCloudRateLabelOf(10_001)), "VALIDATION_FAILED", "and one above the ceiling");
  expectEqual(errorCodeOf(() => taxCloudRateLabelOf(8.5)), "VALIDATION_FAILED", "and a rate that is not whole basis points");
}

/* ---- section 4: the totals ---- */

function checkTotals(): void {
  const one = taxCloudTaxTotalsOf([rowOf()]);

  expectEqual(one.currency, "USD", "the report names its currency");
  expectEqual(one.invoiceCount, 1, "one invoice");
  expectEqual(one.companyCount, 1, "one merchant");
  expectEqual(one.taxMinor, 21_000n, "the tax invoiced");
  expectEqual(one.collectedTaxMinor, 13_000n, "the tax collected");
  expectEqual(one.outstandingTaxMinor, 8_000n, "and what is not collected yet");
  expectEqual(one.byCompany[0]?.companyId, COMPANY, "the merchant is listed");
  expectEqual(one.byCompany[0]?.outstandingTaxMinor, 8_000n, "with its own outstanding tax");

  const twoRows = taxCloudTaxTotalsOf([
    rowOf(),
    rowOf({ invoiceId: "another", taxMinor: 5_000n, collectedTaxMinor: 5_000n }),
    rowOf({ companyId: OTHER_COMPANY, invoiceId: "third", taxMinor: 62_500n, collectedTaxMinor: 0n }),
  ]);

  expectEqual(twoRows.invoiceCount, 3, "three invoices");
  expectEqual(twoRows.companyCount, 2, "two merchants");
  expectEqual(twoRows.taxMinor, 88_500n, "the platform's tax is the sum");
  expectEqual(twoRows.collectedTaxMinor, 18_000n, "and its collected tax");
  expectEqual(twoRows.outstandingTaxMinor, 70_500n, "and what remains");
  expectEqual(twoRows.byCompany[0]?.companyId, COMPANY, "the merchant with the most collected tax is first");
  expectEqual(twoRows.byCompany[0]?.invoiceCount, 2, "with both of its invoices");
  expectEqual(twoRows.byCompany[0]?.taxMinor, 26_000n, "and its own sum");
  expectEqual(
    twoRows.byCompany.reduce((total, company) => total + company.taxMinor, 0n),
    twoRows.taxMinor,
    "the merchants add up to the platform",
  );

  const tie = taxCloudTaxTotalsOf([
    rowOf({ companyId: THIRD_COMPANY, collectedTaxMinor: 1_000n }),
    rowOf({ companyId: OTHER_COMPANY, collectedTaxMinor: 1_000n }),
  ]);

  expectEqual(tie.byCompany[0]?.companyId, OTHER_COMPANY, "a tie breaks on the merchant's id, so two runs read the same way");
  expectEqual(tie.byCompany[1]?.companyId, THIRD_COMPANY, "and the next id follows");

  const empty = taxCloudTaxTotalsOf([]);

  expectEqual(empty.invoiceCount, 0, "no invoices is no invoices");
  expectEqual(empty.taxMinor, 0n, "and no tax");
  expectEqual(empty.byCompany.length, 0, "and no merchant");
  expectEqual(empty.outstandingTaxMinor, 0n, "and nothing outstanding");

  const paid = taxCloudTaxTotalsOf([rowOf({ taxMinor: 10_000n, collectedTaxMinor: 10_000n })]);

  expectEqual(paid.outstandingTaxMinor, 0n, "a fully collected invoice owes no tax");

  const refusals: readonly (readonly [string, readonly TaxCloudTaxTotalRow[]])[] = [
    ["two currencies in one report", [rowOf(), rowOf({ currency: "EUR" })]],
    ["a negative tax", [rowOf({ taxMinor: -1n })]],
    ["a negative collected amount", [rowOf({ collectedTaxMinor: -1n })]],
    ["more collected than invoiced", [rowOf({ taxMinor: 10n, collectedTaxMinor: 11n })]],
    ["an instant that is not one", [rowOf({ calculatedAtEpochMs: 0 })]],
  ];

  for (const [name, rows] of refusals) {
    expectEqual(errorCodeOf(() => taxCloudTaxTotalsOf(rows)), "VALIDATION_FAILED", `the totals refuse ${name}`);
  }

  const many = Array.from({ length: TAXCLOUD_TOTALS_MAXIMUM_COMPANIES + 1 }, (_unused, index) =>
    rowOf({ companyId: `company_${String(index).padStart(3, "0")}` }),
  );

  expectEqual(
    errorCodeOf(() => taxCloudTaxTotalsOf(many)),
    "VALIDATION_FAILED",
    "a report longer than five hundred merchants is refused rather than truncated",
  );
  expectEqual(
    errorCodeOf(() => taxCloudTaxTotalsOf(many.slice(0, TAXCLOUD_TOTALS_MAXIMUM_COMPANIES))),
    "no_error",
    "and exactly five hundred is a report",
  );
}

function checkWindow(): void {
  const rows = [
    rowOf({ invoiceId: "before", calculatedAtEpochMs: NOW - 3 * DAY_MS }),
    rowOf({ invoiceId: "at-the-start", calculatedAtEpochMs: NOW - DAY_MS }),
    rowOf({ invoiceId: "inside", calculatedAtEpochMs: NOW - 1_000 }),
    rowOf({ invoiceId: "at-the-end", calculatedAtEpochMs: NOW }),
  ];
  const window = taxCloudTaxTotalsInWindowOf(rows, { fromEpochMs: NOW - DAY_MS, toEpochMs: NOW });

  expectEqual(window.invoiceCount, 2, "a half open window counts the start instant and not the end");
  expectEqual(window.taxMinor, 42_000n, "with their tax");
  expectEqual(window.byCompany.length, 1, "and one merchant");

  expectEqual(
    errorCodeOf(() => taxCloudTaxTotalsInWindowOf(rows, { fromEpochMs: NOW, toEpochMs: NOW })),
    "VALIDATION_FAILED",
    "a window that ends where it starts is refused",
  );
  expectEqual(
    errorCodeOf(() => taxCloudTaxTotalsInWindowOf(rows, { fromEpochMs: NOW, toEpochMs: NOW - DAY_MS })),
    "VALIDATION_FAILED",
    "and one that runs backwards",
  );
  expectEqual(
    errorCodeOf(() => taxCloudTaxTotalsInWindowOf(rows, { fromEpochMs: 1.5, toEpochMs: NOW })),
    "VALIDATION_FAILED",
    "and an instant that is not whole milliseconds",
  );
}

/* ---- section 5: the invoice's view ---- */

function checkView(): void {
  const shown = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf(),
    lines: [lineOf({ lineIndex: 1, invoiceItemId: LINE_TWO, taxableMinor: 100_000n, taxMinor: 8_000n, rateBp: 800 }), lineOf()],
  });

  expect("view" in shown, "a complete invoice has a view");

  const view = "view" in shown ? shown.view : null;

  expectEqual(view?.rows.length, 4, "four rows");
  expectEqual(view?.rows.map((row) => row.key).join(","), "subtotal,discount,tax,total", "in the order a client reads them");
  expectEqual(view?.rows[0]?.label, "Subtotal", "the first is the subtotal");
  expectEqual(view?.rows[0]?.amountMinor, 261_250n, "with its amount");
  expectEqual(view?.rows[0]?.amountText, "USD 26.12", "and its text");
  expectEqual(view?.rows[2]?.label, "Sales tax", "the third is the tax line section 7 asks for");
  expectEqual(view?.rows[2]?.amountMinor, 21_000n, "with the invoice's tax");
  expectEqual(view?.rows[2]?.emphasis, "tax", "marked as the tax row");
  expectEqual(view?.rows[3]?.emphasis, "total", "and the total is the emphasised row");
  expectEqual(view?.rows[1]?.emphasis, "none", "while the discount is not");
  expectEqual(view?.lines.length, 2, "one line per taxed line");
  expectEqual(view?.lines[0]?.index, 0, "in the invoice's order");
  expectEqual(view?.lines[1]?.index, 1, "not the order they were given in");
  expectEqual(view?.lines[0]?.rateLabel, "8.13%", "with the rate a merchant reads");
  expectEqual(view?.taxLineShown, true, "a taxed invoice shows its tax line");
  expectEqual(view?.notice, null, "and needs no sentence");
  expectEqual(view?.paidMinor, null, "no payment means no paid figure");
  expectEqual(view?.outstandingMinor, null, "and no outstanding figure");

  const paidView = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf(),
    lines: [lineOf(), lineOf({ invoiceItemId: LINE_TWO, lineIndex: 1, taxableMinor: 100_000n, taxMinor: 8_000n, rateBp: 800 })],
    payment: { paidMinor: 100_000n, collectedTaxMinor: 8_000n },
  });

  expectEqual("view" in paidView ? paidView.view.paidMinor : null, 100_000n, "a payment is shown");
  expectEqual("view" in paidView ? paidView.view.collectedTaxMinor : null, 8_000n, "with the tax it collected");
  expectEqual("view" in paidView ? paidView.view.outstandingMinor : null, 182_250n, "and what the client still owes");

  const noTax = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf({ taxMinor: 0n, totalMinor: 261_250n }),
    lines: [],
  });

  expectEqual("view" in noTax ? noTax.view.taxLineShown : null, false, "an invoice with no tax shows no tax line");
  expectEqual("view" in noTax ? noTax.view.notice : "", TAXCLOUD_NO_TAX_SENTENCE, "and says so in a sentence");
  expectEqual("view" in noTax ? noTax.view.rows.length : null, 4, "the four rows stay, with the tax at zero");

  const decision: TaxCloudCollectionDecision = {
    collect: false,
    reason: "switched_off",
    message: taxCloudCollectionDecisionMessageOf("switched_off"),
  };
  const withDecision = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf({ taxMinor: 0n, totalMinor: 261_250n }),
    lines: [],
    decision,
  });

  expectEqual(
    "view" in withDecision ? withDecision.view.notice : "",
    taxCloudCollectionDecisionMessageOf("switched_off"),
    "the screen shows STEP 178's own sentence rather than inventing one",
  );

  const collecting = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf({ taxMinor: 0n, totalMinor: 261_250n }),
    lines: [],
    decision: { collect: true, reason: "collect", message: taxCloudCollectionDecisionMessageOf("collect") },
  });

  expectEqual("view" in collecting ? collecting.view.notice : "", TAXCLOUD_NO_TAX_SENTENCE, "a collecting merchant with no tax reads the plain sentence");

  const refusals: readonly (readonly [string, Parameters<typeof taxCloudInvoiceTotalsViewOf>[0]])[] = [
    ["a currency in lower case", { invoice: invoiceOf({ currency: "usd" }), lines: [] }],
    ["a negative subtotal", { invoice: invoiceOf({ subtotalMinor: -1n }), lines: [] }],
    ["a discount above the subtotal", { invoice: invoiceOf({ discountMinor: 300_000n }), lines: [] }],
    ["a total that is not its parts", { invoice: invoiceOf({ totalMinor: 282_251n }), lines: [] }],
    ["a line from another invoice", { invoice: invoiceOf(), lines: [lineOf({ invoiceId: "another-invoice" })] }],
    ["a negative line", { invoice: invoiceOf(), lines: [lineOf({ taxMinor: -1n })] }],
    ["a line taxed above its amount", { invoice: invoiceOf(), lines: [lineOf({ taxMinor: 200_000n, taxableMinor: 100_000n })] }],
    ["a rate outside the vocabulary", { invoice: invoiceOf(), lines: [lineOf({ rateBp: 10_001 })] }],
    ["lines that do not add up", { invoice: invoiceOf(), lines: [lineOf({ taxMinor: 10_000n }), lineOf({ invoiceItemId: LINE_TWO, lineIndex: 1, taxMinor: 1_000n })] }],
    ["tax without a breakdown", { invoice: invoiceOf(), lines: [] }],
    ["a payment larger than the invoice", { invoice: invoiceOf(), lines: [lineOf(), lineOf({ invoiceItemId: LINE_TWO, lineIndex: 1, taxMinor: 8_000n })], payment: { paidMinor: 300_000n, collectedTaxMinor: 0n } }],
    ["more collected tax than the invoice carries", { invoice: invoiceOf(), lines: [lineOf(), lineOf({ invoiceItemId: LINE_TWO, lineIndex: 1, taxMinor: 8_000n })], payment: { paidMinor: 0n, collectedTaxMinor: 30_000n } }],
  ];

  for (const [name, input] of refusals) {
    const answer = taxCloudInvoiceTotalsViewOf(input);

    expect("reason" in answer, `the view refuses ${name}`);
  }

  // A discount is its own row, and the total still adds up across the four.
  const discounted = taxCloudInvoiceTotalsViewOf({
    invoice: invoiceOf({ subtotalMinor: 261_250n, discountMinor: 61_250n, taxMinor: 16_000n, totalMinor: 216_000n }),
    lines: [lineOf({ taxableMinor: 200_000n, taxMinor: 16_000n, rateBp: 800 })],
  });

  const discountedRows = "view" in discounted ? discounted.view.rows : [];
  const amountAt = (index: number): bigint => discountedRows[index]?.amountMinor ?? -1n;

  expectEqual(
    amountAt(0) - amountAt(1) + amountAt(2),
    amountAt(3),
    "the four rows add up the way the invoice's own check does",
  );
}

/* ---- section 6: the source ---- */

function checkSource(): void {
  const source = readFileSync(new URL("./taxcloud-tax-totals.ts", import.meta.url), "utf8");

  for (const method of ["log", "error", "warn", "info"]) {
    expectEqual(source.includes(["console", method].join(".")), false, `the source never calls console.${method}`);
  }

  expectEqual(source.includes("sandbox"), false, "the word the documentation refuses appears nowhere");
  expectEqual(source.includes("toFixed("), false, "money is never formatted through a float");
  expectEqual(source.includes("parseFloat"), false, "and never parsed through one");
  expectEqual(source.includes("Number("), false, "no money is converted through a float constructor either");
  expect(source.includes("MINOR_PER_UNIT"), "the minor unit comes from the payment money module");
  expect(source.includes("taxCloudCollectionDecisionMessageOf"), "the sentence comes from STEP 178's vocabulary");

  // The four rows are built from the invoice and nothing else, so the block cannot show a fifth.
  expectEqual(TAXCLOUD_TOTALS_ROW_KEYS.length, 4, "the block has four rows");
  expectEqual(new Set(TAXCLOUD_TOTALS_ROW_KEYS).size, 4, "and no repeated key");
}

/* ---- running ---- */

checkLabels();
checkMoneyText();
checkRateLabel();
checkTotals();
checkWindow();
checkView();
checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud tax totals gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud tax totals gate passed: ${checks} checks (the tax of many invoices sums per sub-merchant and platform wide with the merchants adding up to the platform, invoiced and collected tax are summed apart so the report answers what a merchant received rather than what a client was charged, a mixed currency, a negative amount, a collected total above the taxed total and a report longer than five hundred merchants are refused rather than coerced, a period is half open so two consecutive returns count every instant once, money is spelled from minor units without a float, a rate prints as the percent a merchant reads, and the invoice's block is four rows that add up with the tax line's place taken by STEP 178's own sentence when there is no tax)\n`,
);
