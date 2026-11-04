// path: services/invoices/invoice-totals.ts
import { INVOICE_QUANTITY_UNITS_PER_ONE } from "./invoice-fields.ts";

/**
 * The arithmetic of `0023`, written once so the form and the database cannot disagree.
 *
 * ## Why this module exists at all when the database already computes
 *
 * `invoice_items.line_total_minor` is a generated column:
 *
 *     (quantity * unit_price_minor)::bigint - discount_minor
 *
 * and `invoice_items_sync_totals` sums those into `invoices.subtotal_minor`. That is the authority, and
 * no value from this module is ever written into those columns. But a form has to show the merchant
 * what the lines add up to *before* they save, and a merchant who reads one total in the browser and
 * another on the saved invoice has found a bug whichever number is right. So the rule is stated here as
 * well, and the gate proves the two agree by running the same inputs through both.
 *
 * ## The two conversions, and why they are not one
 *
 * A quantity is typed in units and stored as `numeric(12,3)`. This module carries it as an integer
 * count of thousandths - `2.5` is `2500` - so no quantity is ever a float here either.
 *
 * `(quantity * unit_price_minor)::bigint` casts a *numeric* product to an integer. PostgreSQL rounds a
 * numeric to `bigint` with **half away from zero**, not by truncating: 2.0005 units of a 1 cent item is
 * `2.0005 * 1 = 2.0005`, which casts to `3`. Truncating would give `2` and the two totals would differ
 * by a cent on exactly the kind of fractional-hour line section 30 is full of. The rounding below is
 * therefore half away from zero, done in integer arithmetic on the thousandths.
 *
 * ## The boundaries `0023` states, restated
 *
 *   - `quantity > 0 and quantity <= 1000000`
 *   - `unit_price_minor >= 0`
 *   - `discount_minor >= 0 and discount_minor <= greatest((quantity * unit_price_minor)::bigint, 0)`
 *   - `invoices_discount_check`: `discount_minor <= subtotal_minor`
 *   - `invoices_total_check`: `total_minor = subtotal_minor - discount_minor + tax_minor` and `>= 0`
 *
 * The discount's ceiling is the *rounded* gross, not the exact product, because that is the value the
 * generated column subtracts from. An exact product of 2.4 that rounds down to 2 can only carry a
 * discount of 2, and this module refuses 3 at the same moment the database would.
 */

/** A line's money inputs, as integers of minor units and thousandths of a unit. */
export interface LineAmounts {
  /** Thousandths of a unit: `2.5` arrives as `2500`. */
  readonly quantityThousandths: bigint;
  readonly unitPriceMinor: bigint;
  readonly discountMinor: bigint;
}

/**
 * `(quantity * unit_price_minor)::bigint`, with PostgreSQL's half-away-from-zero rounding.
 *
 * The product is computed exactly in integers - thousandths times minor units - and then divided by
 * 1000 with the remainder deciding the direction. A negative product rounds away from zero too, which
 * matches the cast; the division is written on the magnitude for that reason.
 */
export function grossLineMinor(input: { readonly quantityThousandths: bigint; readonly unitPriceMinor: bigint }): bigint {
  const product = input.quantityThousandths * input.unitPriceMinor;
  const magnitude = product < 0n ? -product : product;
  const whole = magnitude / INVOICE_QUANTITY_UNITS_PER_ONE;
  const remainder = magnitude % INVOICE_QUANTITY_UNITS_PER_ONE;

  // Half or more of a thousandth rounds up, away from zero.
  const rounded = remainder * 2n >= INVOICE_QUANTITY_UNITS_PER_ONE ? whole + 1n : whole;

  return product < 0n ? -rounded : rounded;
}

/** `line_total_minor`, exactly as the generated column computes it. */
export function lineTotalMinor(line: LineAmounts): bigint {
  return (
    grossLineMinor({ quantityThousandths: line.quantityThousandths, unitPriceMinor: line.unitPriceMinor }) -
    line.discountMinor
  );
}

/** What one invoice's lines add up to, before the invoice-level discount and the tax line. */
export interface InvoiceTotals {
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
}

/**
 * `subtotal - discount + tax`, which is `invoices_derive_total` verbatim.
 *
 * The subtotal is the sum of the live lines, so it is passed in rather than recomputed here: the
 * caller has the lines and this module has no business deciding which of them are live.
 */
export function invoiceTotalsOf(input: {
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
}): InvoiceTotals {
  return {
    subtotalMinor: input.subtotalMinor,
    discountMinor: input.discountMinor,
    taxMinor: input.taxMinor,
    totalMinor: input.subtotalMinor - input.discountMinor + input.taxMinor,
  };
}

/** The sum of a set of line totals. Empty is zero, which is what `coalesce(sum(...), 0)` answers. */
export function subtotalOf(lines: readonly LineAmounts[]): bigint {
  return lines.reduce((total, line) => total + lineTotalMinor(line), 0n);
}


/**
 * A typed quantity as thousandths, or null when it is not one.
 *
 * The pattern is `0023`'s scale: at most three decimals, at most seven integer digits. Parsing is done
 * by string surgery so `2.5` is exactly `2500` - `Number("2.5") * 1000` is a float multiplication that
 * happens to be exact for this value and is not exact for others.
 */
export function quantityToThousandths(input: string): bigint | null {
  const text = input.trim();

  if (!/^\d{1,7}([.]\d{1,3})?$/u.test(text)) {
    return null;
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const padded = fraction.padEnd(3, "0");

  return BigInt(whole) * INVOICE_QUANTITY_UNITS_PER_ONE + BigInt(padded);
}

/** A stored quantity, as the decimal text the form shows: `2500` becomes `2.5`, `1000` becomes `1`. */
export function thousandthsToQuantity(thousandths: bigint): string {
  const whole = thousandths / INVOICE_QUANTITY_UNITS_PER_ONE;
  const fraction = thousandths % INVOICE_QUANTITY_UNITS_PER_ONE;

  if (fraction === 0n) {
    return whole.toString();
  }

  // Trim the trailing zeros of the fraction so 2.500 prints as 2.5 and 2.050 prints as 2.05.
  const digits = fraction.toString().padStart(3, "0").replace(/0+$/u, "");

  return `${whole.toString()}.${digits}`;
}

/** A `numeric(12,3)` column as PostgREST answers it: a decimal string, or a number when it is small. */
export function quantityColumnToThousandths(value: string | number): bigint | null {
  const text = typeof value === "number" ? String(value) : value.trim();

  return quantityToThousandths(text);
}
