// path: services/invoices/invoice-discount.ts
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import {
  invoiceTotalsOf,
  subtotalOf,
  type InvoiceTotals,
  type LineAmounts,
} from "./invoice-totals.ts";

/**
 * The invoice-level discount: how it is expressed, what it resolves to, and what the totals become.
 *
 * ## Why a basis exists at all
 *
 * A discount is an instruction as much as it is an amount. "Twenty dollars off" and "ten percent off"
 * both resolve to money, but they answer different questions when the invoice changes: the first is a
 * fixed concession that survives an edit, the second is a share of whatever the lines now add up to. The
 * database stores the resolved money in `invoices.discount_minor`, because `invoices_total_check` has to
 * hold on the row itself and every reading query already uses it. `discount_basis` and
 * `discount_percent_bp`, added by `0112`, record which of the two the merchant actually said.
 *
 * ## Why basis points
 *
 * A percentage is `integer` hundredths of a percent: 10 percent is 1000, 12.5 percent is 1250. Storing
 * twenty-five percent as `0.25` in a numeric would be exact too, but it would put a decimal scale in the
 * middle of an integer pipeline and invite a float somewhere downstream. Basis points are the smallest
 * unit a merchant's screen offers, so nothing is lost in the round trip, and every multiplication below
 * stays in `bigint`.
 *
 * ## Why the ceiling is 100 percent
 *
 * A discount larger than the subtotal cannot produce a billable total - `invoices_discount_check` refuses
 * it and so would any accountant - so a percentage above 10000 is not a discount to be clamped, it is a
 * value that cannot describe an invoice. It is refused rather than truncated.
 */

/** The only hundred percent a discount may express, in basis points. */
export const DISCOUNT_BASIS_POINTS_PER_PERCENT = 100n;

/** One hundred percent, in basis points. The largest percentage a discount can carry. */
export const DISCOUNT_PERCENT_MAXIMUM_BP = 10_000;

/** How an invoice-level discount was expressed. */
export const DISCOUNT_BASES = ["amount", "percent"] as const;

export type DiscountBasis = (typeof DISCOUNT_BASES)[number];

export const DISCOUNT_DEFAULT_BASIS: DiscountBasis = "amount";

export function isDiscountBasis(value: unknown): value is DiscountBasis {
  return typeof value === "string" && (DISCOUNT_BASES as readonly string[]).includes(value);
}

/**
 * A typed percentage as basis points, or null when it is not one.
 *
 * ## Why this is string surgery and not `Number`
 *
 * `Number("12.5") * 100` is 1250 for this value and is not exact for others (`0.29 * 100` is
 * 28.999999999999996). Parsing the text means `12.5` is exactly 1250 without an intermediate that can be
 * wrong. The pattern allows up to two decimals - the hundredth of a percent a basis point represents - and
 * up to three integer digits, because 100 is the ceiling and `100` is the only three-digit value that can
 * be legal. A trailing `%` is tolerated because merchants type one, and it is the character their screen
 * prints beside the box.
 *
 * ## Why the sign is not accepted
 *
 * A negative percentage is a surcharge wearing a discount's name. The column refuses it and so does this
 * parser, so a caller cannot reach the database with a value it will reject.
 */
export function percentToBasisPoints(input: string): bigint | null {
  const text = input.trim().replace(/%$/u, "").trim();

  if (!/^\d{1,3}([.]\d{1,2})?$/u.test(text)) {
    return null;
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const padded = fraction.padEnd(2, "0");
  const basisPoints = BigInt(whole) * DISCOUNT_BASIS_POINTS_PER_PERCENT + BigInt(padded.length === 0 ? "0" : padded);

  return basisPoints <= BigInt(DISCOUNT_PERCENT_MAXIMUM_BP) ? basisPoints : null;
}

/** Basis points as the text a screen shows: `1250` becomes `12.5`, `1000` becomes `10`, `125` becomes `1.25`. */
export function basisPointsToPercent(basisPoints: bigint): string {
  const whole = basisPoints / DISCOUNT_BASIS_POINTS_PER_PERCENT;
  const fraction = basisPoints % DISCOUNT_BASIS_POINTS_PER_PERCENT;

  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction.toString().padStart(2, "0").replace(/0+$/u, "")}`;
}

/**
 * The money a percentage discount is worth on a subtotal, rounded half away from zero.
 *
 * `subtotal * bp / 10000` is almost never a whole cent - ten percent of 12.34 is 1.234 - and the division
 * has to decide a direction. It rounds half away from zero, the same direction `grossLineMinor` rounds
 * `(quantity * unit_price)::bigint`, because two roundings inside one document that disagreed would let a
 * line's own total and the invoice's total drift apart by a cent the merchant cannot explain.
 *
 * Nothing here can be negative: both operands are refused if they are, and a non-negative product divided
 * with this rule is non-negative. The sign handling is still written out so the function is correct on its
 * own terms rather than by assumption about its caller.
 */
export function percentDiscountMinor(input: {
  readonly subtotalMinor: bigint;
  readonly basisPoints: bigint;
}): bigint {
  const product = input.subtotalMinor * input.basisPoints;
  const magnitude = product < 0n ? -product : product;
  const divisor = BigInt(DISCOUNT_PERCENT_MAXIMUM_BP);
  const whole = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? whole + 1n : whole;

  return product < 0n ? -rounded : rounded;
}

/** A stored discount, as the two columns and the money they resolve to. */
export interface DiscountState {
  readonly basis: DiscountBasis;
  /** Set only when the basis is `percent`, so a flat amount carries no percentage to misread. */
  readonly basisPoints: bigint;
  /** The resolved money. For a percentage this is recomputed whenever the subtotal moves. */
  readonly discountMinor: bigint;
}

/**
 * Resolve a discount against a subtotal.
 *
 * For `amount` the money is the instruction and is returned as it was given; for `percent` it is the
 * share of the subtotal the percentage names.
 */
export function resolveDiscount(input: {
  readonly basis: DiscountBasis;
  readonly basisPoints: bigint;
  readonly amountMinor: bigint;
  readonly subtotalMinor: bigint;
}): bigint {
  if (input.basis === "amount") {
    return input.amountMinor;
  }

  return percentDiscountMinor({ subtotalMinor: input.subtotalMinor, basisPoints: input.basisPoints });
}

/**
 * The whole document in one call: what the live lines add up to, what the discount takes off, what tax
 * adds, and what is left to pay.
 *
 * The steps are the ones the database performs, in the order it performs them:
 *
 *   1. `invoice_items_sync_totals` sums the **live** lines into `subtotal_minor`;
 *   2. the discount is resolved against that subtotal and subtracted, bounded by `invoices_discount_check`;
 *   3. `invoices_derive_total` writes `total = subtotal - discount + tax`.
 *
 * A percentage discount must be resolved *between* steps 1 and 3, which is the substance of this STEP: it
 * is a function of the subtotal, not a value that can sit on the row independently of it. `subtotalOf` and
 * `invoiceTotalsOf` are reused rather than restated, so the identity and the rounding direction are
 * written once in `invoice-totals.ts` for the whole application.
 *
 * The lines arrive already filtered to `deleted_at is null`, which is the filter the trigger applies; the
 * parameter is named for that so a caller cannot pass every row it read and get a plausible wrong answer.
 */
export function selectInvoiceTotals(input: {
  readonly liveLines: readonly LineAmounts[];
  readonly discount: DiscountState;
  readonly taxMinor: bigint;
}): InvoiceTotals {
  const subtotalMinor = subtotalOf(input.liveLines);

  return invoiceTotalsOf({
    subtotalMinor,
    discountMinor: resolveDiscount({
      basis: input.discount.basis,
      basisPoints: input.discount.basisPoints,
      amountMinor: input.discount.discountMinor,
      subtotalMinor,
    }),
    taxMinor: input.taxMinor,
  });
}

/**
 * Basis points as the `integer` a column stores.
 *
 * A `bigint` cannot cross JSON - `JSON.stringify` throws on one, and the REST layer has no replacer - so a
 * percentage written to `discount_percent_bp` has to become a number first. That is safe here and nowhere
 * near the money: the value has already been bounded to `10000` by `percentToBasisPoints`, so nothing is
 * lost in a conversion that would be a silent truncation for a larger integer. Money never takes this
 * path; every optional amount is sent as decimal text instead.
 */
export function basisPointsToColumn(basisPoints: bigint): number {
  if (basisPoints < 0n || basisPoints > BigInt(DISCOUNT_PERCENT_MAXIMUM_BP)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "discount", rule: "too_large" }] });
  }

  return Number(basisPoints);
}

/**
 * Why a discount cannot be applied to a subtotal, or null when it can.
 *
 * This is the sentence `invoices_discount_check` would give as a 500. The check is `discount_minor <=
 * subtotal_minor`, and it runs after `invoice_items_sync_totals` has already written the new subtotal - so
 * a discount that is now too large does not get refused politely, it fails the parent's own update and the
 * line change that caused it is rejected with it. Naming the problem before the write is what turns that
 * into a field error on the discount instead of an unexplained failure on whichever line the merchant
 * happened to remove.
 *
 * A percentage discount can never trigger it: the percentage is at most 100 percent, so the resolved money
 * is at most the subtotal. A flat amount can, and that is the unsafe case this exists for.
 */
export function discountProblemAt(input: {
  readonly basis: DiscountBasis;
  readonly discountMinor: bigint;
  readonly subtotalMinor: bigint;
}): ErrorDetail | null {
  if (input.discountMinor < 0n) {
    return { field: "discount", rule: "invalid_format" };
  }

  if (input.basis === "percent") {
    return null;
  }

  if (input.discountMinor > input.subtotalMinor) {
    return { field: "discount", rule: "too_large" };
  }

  return null;
}

/**
 * Refuse a discount that the current subtotal cannot carry.
 *
 * Called by every path that changes a line, because that is the moment a stored flat discount can become
 * larger than what the remaining lines add up to. `CONFLICT` rather than `VALIDATION_FAILED` is deliberate:
 * the request that arrives is about a line, and the value that has to change is not in it. The merchant is
 * not being told their input was malformed, they are being told a stored value now needs attention, and the
 * field names which one.
 */
export function assertDiscountFits(input: {
  readonly basis: DiscountBasis;
  readonly discountMinor: bigint;
  readonly subtotalMinor: bigint;
}): void {
  const problem = discountProblemAt(input);

  if (problem === null) {
    return;
  }

  throw new AppError("CONFLICT", { details: [problem] });
}

/** What a discount row reads as, before anything is resolved against a subtotal. */
export interface DiscountColumns {
  readonly discount_minor: bigint;
  readonly discount_basis: string;
  readonly discount_percent_bp: number;
}

/**
 * The discount a row carries, normalised.
 *
 * A row written before `0112` has the column defaults - `amount` and zero - so it reads as a flat amount,
 * which is what it was. A row whose basis somehow does not parse is treated as `amount` rather than
 * refused: the money is still valid and refusing to read an invoice over a label would be worse than
 * reading it as the thing every older row is.
 */
export function discountStateOf(row: DiscountColumns): DiscountState {
  const basis: DiscountBasis = isDiscountBasis(row.discount_basis) ? row.discount_basis : DISCOUNT_DEFAULT_BASIS;

  return {
    basis,
    basisPoints: basis === "percent" ? BigInt(row.discount_percent_bp) : 0n,
    discountMinor: row.discount_minor,
  };
}
