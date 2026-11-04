// path: services/products/price.ts
import { z } from "zod";

/**
 * How this block reads and prints a price.
 *
 * ## Why a price is typed in major units and stored in minor ones
 *
 * `0020` and `0021` store `unit_price_minor` as a `bigint` of whole minor units, exactly as `plans`
 * does, and MASTER_PROMPT rule 2 forbids a float anywhere near money. A merchant, though, types
 * `12.50`, not `1250`, and a form that asked for minor units would be a form that turns one mistyped
 * zero into a hundredfold invoice. The conversion therefore happens here, once: the merchant's text is
 * parsed into minor units by decimal string arithmetic, and the screen prints a stored value back in
 * major units the same way. No `Number` ever holds an amount, and `1e3`, `12,50` and `12.505` are each
 * refused rather than silently coerced.
 *
 * ## Why four decimal places
 *
 * A unit price is multiplied by a decimal quantity on the invoice line (`0023`'s `numeric(12,3)`), so
 * a fourth place is meaningful and a fifth is not: the storage keeps whole minor units, which leaves
 * the fourth place as the smallest amount a line can move. The platform's own `numeric(18,4)` is the
 * same scale one step out, and `config/app.ts` fixes it.
 *
 * ## What this module deliberately is not
 *
 * It is not STEP 127's money module. That STEP owns rounding, currency arithmetic and the ledger's
 * decimal rules across the payment core; this file is the one conversion a catalogue form needs, kept
 * beside the two services that use it so the payment block can build the general case without
 * inheriting a catalogue's opinion.
 */

/** The scale this module works at: four decimal places, matching `config/app.ts`'s `money.scale`. */
export const PRICE_SCALE = 4;

/** `10 ** PRICE_SCALE` as a bigint: the value of one major unit in minor units. */
export const PRICE_MINOR_PER_UNIT = 10_000n;

/**
 * The largest price a catalogue row may carry, in minor units.
 *
 * A hundred billion minor units is ten million major units per item: far beyond any real unit price
 * and still inside the `bigint` column by a wide margin, so the ceiling is a data entry guard and not
 * a storage limit.
 */
export const PRICE_MAXIMUM_MINOR = 1_000_000_000_000n;

/**
 * A price as a merchant types it: digits, an optional group of one to four decimals, nothing else.
 *
 * No sign (a catalogue price is never negative, which `0020` and `0021` also check), no thousands
 * separator, no exponent, no currency symbol - each of those is a value the merchant meant differently
 * from what a parser would read.
 */
export const PRICE_INPUT_PATTERN = /^\d{1,12}([.]\d{1,4})?$/u;

/** A price as the screen prints it: whole part, point, four places. */
export const PRICE_DISPLAY_PATTERN = /^\d{1,12}[.]\d{4}$/u;

/**
 * Parse typed major units into stored minor units, or null when the text is not a price.
 *
 * The arithmetic is entirely on strings and `BigInt`: `12.5` becomes `125000` because `12 * 10^4`
 * plus `5000`, and never `12.5 * 10000` in floating point. A value past `PRICE_MAXIMUM_MINOR` is null,
 * so the caller can answer `too_large` rather than write a number the screen could not print back.
 */
export function priceToMinor(input: string): bigint | null {
  const text = input.trim();

  if (!PRICE_INPUT_PATTERN.test(text)) {
    return null;
  }

  const [whole = "0", fraction = ""] = text.split(".");
  const padded = `${fraction}0000`.slice(0, PRICE_SCALE);
  const minor = BigInt(whole) * PRICE_MINOR_PER_UNIT + BigInt(padded);

  return minor <= PRICE_MAXIMUM_MINOR ? minor : null;
}

/** Print stored minor units as typed major units: `1250` becomes `0.1250`. */
export function priceFromMinor(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / PRICE_MINOR_PER_UNIT;
  const fraction = (absolute % PRICE_MINOR_PER_UNIT).toString().padStart(PRICE_SCALE, "0");

  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/**
 * The price column as PostgREST answers it.
 *
 * A `bigint` arrives as a number when it is small enough and as a string when it is not, so the column
 * is normalised to a `bigint` through its decimal text either way - the same discipline
 * `services/kyc/payment-hold.ts` applies to its own money column, for the same reason.
 */
export const priceColumnSchema = z
  .union([z.string(), z.number()])
  .transform((value, context) => {
    const text = typeof value === "number" ? String(value) : value.trim();

    if (!/^\d{1,15}$/u.test(text)) {
      context.addIssue({ code: "custom", message: "not a whole number of minor units" });

      return z.NEVER;
    }

    return BigInt(text);
  });

/** What a typed price means, for a caller that has to word the refusal. */
export type PriceProblem = "invalid_format" | "too_large";

/** Why a typed price was refused, or null when it is a price. */
export function priceProblemOf(input: string): PriceProblem | null {
  const text = input.trim();

  if (!PRICE_INPUT_PATTERN.test(text)) {
    return "invalid_format";
  }

  return priceToMinor(text) === null ? "too_large" : null;
}
