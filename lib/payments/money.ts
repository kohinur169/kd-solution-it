// path: lib/payments/money.ts

/**
 * The payment core's money: an exact decimal, a currency guard, and the arithmetic that keeps a
 * balance exact.
 *
 * ## What money is here
 *
 * Money is a value with two parts: an exact number of minor units and the currency it is denominated
 * in. The number is a `bigint` - whole minor units at the platform's four-decimal scale - so every
 * calculation on it is exact. `12.5` dollars is `125000` minor units, `12 * 10^4 + 5000`, and never
 * `12.5 * 10000` in floating point. That is the decimal library the master prompt names: not a
 * package (the platform carries four dependencies and `package.json` is integrator-owned), but the
 * discipline of doing every sum on whole minor units and formatting only at the edges.
 *
 * ## Why the currency guard is a guard and not a comment
 *
 * The master prompt says USD only. A money value that carried any other currency would be a value the
 * platform's balances, its settlement and its payout could not reconcile, and a guard that throws is
 * the one place that refusal can be made before the value reaches a balance. The guard is closed on
 * the currencies the platform carries - a list with one entry today - so a currency added later is a
 * change to the list and not a hole in the guard.
 *
 * ## What this file is not
 *
 * It is not the ledger. It does not post entries, it does not read the database, and it does not know
 * that a payment and a fee are two sides of one double entry. It is the value those postings move:
 * the number, the currency, and the arithmetic that proves a set of debits and credits balances.
 *
 * ## The scale
 *
 * Four decimal places, matching `config/app.ts`'s `money.scale` and the database's `numeric(18,4)`.
 * The ceiling is the database's own: `numeric(18,4)` holds a value up to `99999999999999.9999`, which
 * is `10^18 - 1` minor units. A value past that is refused at construction, so no `Money` ever leaves
 * this file carrying a number the database could not store.
 */

import { deepFreeze } from "../utils/freeze.ts";

/** The scale every money value is stored and calculated at: four decimal places. */
export const MONEY_SCALE = 4;

/** `10 ** MONEY_SCALE` as a bigint: the value of one major unit in minor units. */
export const MINOR_PER_UNIT = 10_000n;

/**
 * The largest money value the database holds, in minor units.
 *
 * `numeric(18,4)` holds a value up to `99999999999999.9999`; at four decimal places that is
 * `10^18 - 1` minor units. A value past it is refused at construction, the way a price past its own
 * ceiling is: the caller words the refusal rather than writing a number the column would reject.
 */
export const MAXIMUM_MINOR = 999_999_999_999_999_999n;

/** The one currency the platform carries, per the master prompt's "USD only". */
export const CURRENCY_USD = "USD" as const;

/** The closed set of currencies the money guard accepts. */
export const CURRENCY_CODES: readonly (typeof CURRENCY_USD)[] = deepFreeze([CURRENCY_USD]);

/** A currency code the platform's money guard carries. */
export type Currency = (typeof CURRENCY_CODES)[number];

/**
 * A money value: an exact number of minor units and the currency it is denominated in.
 *
 * The `minor` field is the database's own representation - the `bigint` column a ledger entry carries
 * - so a `Money` read from a row and a `Money` built by arithmetic are the same type and the same
 * scale, and a sum of them is a sum the database would accept.
 */
export interface Money {
  /** The exact amount, in minor units. Negative when the value is a debit or a debt. */
  readonly minor: bigint;
  /** The currency the value is denominated in, always one the guard carries. */
  readonly currency: Currency;
}

/** True when the code is one the platform's money guard carries. */
export function isCurrency(code: string): code is Currency {
  return (CURRENCY_CODES as readonly string[]).includes(code);
}

/**
 * The currency guard: a code that is not carried is a refusal, not a guess.
 *
 * A caller that built a value in a currency the platform does not carry has built a value no balance
 * can hold, and the refusal belongs here - at the point the value is made - rather than at the point
 * it is written to a balance.
 */
export function requireCurrency(code: string): Currency {
  if (!isCurrency(code)) {
    throw new Error(`the platform carries no ${code}`);
  }

  return code;
}

/** True when two money values are denominated in the same currency. */
function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

/** The currency guard for arithmetic: two values of different currencies cannot be summed. */
function requireSameCurrency(a: Money, b: Money): void {
  if (!sameCurrency(a, b)) {
    throw new Error(`cannot add ${a.currency} and ${b.currency}`);
  }
}

/**
 * Build a money value from its exact minor units.
 *
 * The value is range-checked against the database's ceiling: a `Money` that carries a number the
 * column could not store is refused here, so no caller has to remember to check.
 */
export function moneyFromMinor(minor: bigint, currency: Currency = CURRENCY_USD): Money {
  requireCurrency(currency);

  if (minor > MAXIMUM_MINOR || minor < -MAXIMUM_MINOR) {
    throw new Error("money value out of the range the database holds");
  }

  return { minor, currency };
}

/** The zero money value: the value a balanced set of postings sums to. */
export function moneyZero(currency: Currency = CURRENCY_USD): Money {
  return moneyFromMinor(0n, currency);
}

/**
 * Build a money value from the way a person or a form types it: digits, a point, up to four places.
 *
 * A sign is allowed, because a money value can be a debit or a debt; a value past the database's
 * ceiling is refused, the way a price past its own ceiling is.
 */
export function moneyFromInput(input: string, currency: Currency = CURRENCY_USD): Money {
  return moneyFromMinor(inputToMinor(input), currency);
}

/** The exact minor units of a money value: the number the database stores. */
export function moneyToMinor(money: Money): bigint {
  return money.minor;
}

/** A money value as the way a person reads it: digits, a point, four places, a sign when negative. */
export function moneyToInput(money: Money): string {
  return minorToInput(money.minor);
}

/** Add two money values of the same currency. */
export function moneyAdd(a: Money, b: Money): Money {
  requireSameCurrency(a, b);

  return moneyFromMinor(a.minor + b.minor, a.currency);
}

/** Subtract one money value from another of the same currency. */
export function moneySubtract(a: Money, b: Money): Money {
  requireSameCurrency(a, b);

  return moneyFromMinor(a.minor - b.minor, a.currency);
}

/** The opposite of a money value: a credit becomes a debit of the same amount. */
export function moneyNegate(money: Money): Money {
  return moneyFromMinor(-money.minor, money.currency);
}

/**
 * Sum a list of money values.
 *
 * The sum of a balanced set of postings is zero, and this is the function that proves it: a caller
 * that has a set of debits and credits sums them here and reads the zero back.
 */
export function moneySum(values: readonly Money[]): Money {
  let total = moneyZero(values[0]?.currency ?? CURRENCY_USD);

  for (const value of values) {
    total = moneyAdd(total, value);
  }

  return total;
}

/** Compare two money values of the same currency: less, equal, or more. */
export function moneyCompare(a: Money, b: Money): -1 | 0 | 1 {
  requireSameCurrency(a, b);

  if (a.minor < b.minor) {
    return -1;
  }

  if (a.minor > b.minor) {
    return 1;
  }

  return 0;
}

/** True when a money value is exactly zero. */
export function moneyIsZero(money: Money): boolean {
  return money.minor === 0n;
}

/** The sign of a money value: negative, zero, or positive. */
export function moneySign(money: Money): -1 | 0 | 1 {
  if (money.minor < 0n) {
    return -1;
  }

  if (money.minor > 0n) {
    return 1;
  }

  return 0;
}

/**
 * Parse typed major units into exact minor units.
 *
 * The arithmetic is entirely on strings and `BigInt`: the whole part is multiplied by `10^4` and the
 * fraction padded to four places, so `12.5` becomes `12 * 10^4 + 5000` and never `12.5 * 10000` in
 * floating point. A value past the database's ceiling is refused.
 */
function inputToMinor(input: string): bigint {
  const text = input.trim();
  const match = /^(-?)(\d{1,14})(?:[.](\d{1,4}))?$/u.exec(text);

  if (match === null) {
    throw new Error(`not a money value: ${text}`);
  }

  const negative = match[1] === "-";
  const whole = BigInt(match[2] ?? "0");
  const fraction = (match[3] ?? "").padEnd(MONEY_SCALE, "0");
  const minor = whole * MINOR_PER_UNIT + BigInt(fraction);

  if (minor > MAXIMUM_MINOR) {
    throw new Error(`money value out of the range the database holds: ${text}`);
  }

  return negative ? -minor : minor;
}

/** Print exact minor units as typed major units: `1250000` becomes `125.0000`. */
function minorToInput(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / MINOR_PER_UNIT;
  const fraction = (absolute % MINOR_PER_UNIT).toString().padStart(MONEY_SCALE, "0");

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
