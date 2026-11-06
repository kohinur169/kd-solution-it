// path: lib/payments/money-verify.ts
import process from "node:process";
import {
  CURRENCY_CODES,
  CURRENCY_USD,
  MAXIMUM_MINOR,
  MINOR_PER_UNIT,
  MONEY_SCALE,
  isCurrency,
  moneyAdd,
  moneyCompare,
  moneyFromInput,
  moneyFromMinor,
  moneyIsZero,
  moneyNegate,
  moneySign,
  moneySum,
  moneySubtract,
  moneyToInput,
  moneyToMinor,
  moneyZero,
  requireCurrency,
} from "./money.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${format(expected)}, received ${format(actual)})`);
  }
}

/** A value in a message: bigint prints as digits, everything else as JSON. */
function format(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return JSON.stringify(value);
}

/** The call was supposed to be refused, and was. */
function throws(call: () => unknown, description: string): void {
  checks += 1;

  try {
    call();
    failures.push(`${description} (was not refused)`);
  } catch {
    // expected
  }
}

/* ---- the scenarios ---- */

/** The currency guard: the platform carries USD and refuses everything else. */
function checkCurrencyGuard(): void {
  expectEqual(CURRENCY_USD, "USD", "the platform's currency is USD");
  expectEqual(CURRENCY_CODES.length, 1, "and the guard carries one currency, closed");

  expect(isCurrency("USD"), "USD is carried");
  expect(!isCurrency("EUR"), "a currency the platform does not carry is not carried");
  expect(!isCurrency("usd"), "and the guard is case sensitive: a lowercase code is not USD");
  expect(!isCurrency(""), "an empty code is not carried");

  expectEqual(requireCurrency("USD"), "USD", "a carried code is accepted");
  throws(() => requireCurrency("EUR"), "a currency the platform does not carry is refused");
  throws(() => moneyFromMinor(100n, "EUR" as never), "a money value built in an uncarried currency is refused");
  throws(() => moneyFromInput("1.0000", "EUR" as never), "a value typed in an uncarried currency is refused");
}

/** The decimal library: every sum is exact, because it is done on whole minor units. */
function checkDecimalExactness(): void {
  // The sum floating point cannot do: 0.1 + 0.2 is 0.3, not 0.30000000000000004.
  const one = moneyFromInput("0.1000");
  const two = moneyFromInput("0.2000");

  expectEqual(one.minor, 1000n, "0.1 is one thousand minor units");
  expectEqual(two.minor, 2000n, "0.2 is two thousand minor units");
  expectEqual(moneyAdd(one, two).minor, 3000n, "and 0.1 + 0.2 is 0.3 exactly, not a floating point sum");

  // A value the database holds at its ceiling, added to zero, is unchanged: no overflow.
  const maximum = moneyFromInput("99999999999999.9999");

  expectEqual(maximum.minor, MAXIMUM_MINOR, "the database's ceiling is a money value");
  expectEqual(moneyAdd(maximum, moneyZero()).minor, MAXIMUM_MINOR, "and adding zero to the ceiling leaves it whole");

  // The scale: four decimal places, the database's own.
  expectEqual(MONEY_SCALE, 4, "the scale is the database's four decimal places");
  expectEqual(MINOR_PER_UNIT, 10_000n, "one major unit is ten thousand minor units");
}

/** The arithmetic: add, subtract, negate, sum, compare, sign, zero. */
function checkArithmetic(): void {
  const a = moneyFromInput("1.0000");
  const b = moneyFromInput("2.0000");

  expectEqual(a.minor, 10_000n, "one dollar is ten thousand minor units");
  expectEqual(b.minor, 20_000n, "two dollars is twenty thousand minor units");
  expectEqual(moneyAdd(a, b).minor, 30_000n, "add sums two values");
  expectEqual(moneySubtract(a, b).minor, -10_000n, "subtract takes one from the other, and the sign follows");
  expectEqual(moneyNegate(a).minor, -10_000n, "negate takes the opposite, a credit to a debit");
  expectEqual(moneyAdd(a, moneyNegate(a)).minor, 0n, "a value and its opposite sum to zero");

  expectEqual(moneySum([a, b, moneyNegate(a)]).minor, 20_000n, "a sum of a set drops the value and its opposite");

  expectEqual(moneyCompare(a, b), -1, "compare reads less");
  expectEqual(moneyCompare(a, a), 0, "and equal");
  expectEqual(moneyCompare(b, a), 1, "and more");

  expect(moneyIsZero(moneyZero()), "zero is zero");
  expect(!moneyIsZero(a), "and a value is not zero");

  expectEqual(moneySign(a), 1, "a positive value reads positive");
  expectEqual(moneySign(moneyNegate(a)), -1, "a negative value reads negative");
  expectEqual(moneySign(moneyZero()), 0, "and zero reads zero");
}

/** The round trip: a value typed, built, and printed back is the value typed. */
function checkRoundTrip(): void {
  const cases = [
    { input: "125.0000", printed: "125.0000", minor: 1_250_000n },
    { input: "-90.0000", printed: "-90.0000", minor: -900_000n },
    { input: "0.0000", printed: "0.0000", minor: 0n },
    { input: "125", printed: "125.0000", minor: 1_250_000n },
    { input: "125.5", printed: "125.5000", minor: 1_255_000n },
    { input: "0.1", printed: "0.1000", minor: 1_000n },
  ];

  for (const { input, printed, minor } of cases) {
    const money = moneyFromInput(input);

    expectEqual(money.minor, minor, `${input} parses to ${minor} minor units`);
    expectEqual(moneyToInput(money), printed, `${input} prints back as ${printed}`);

    // And the round trip through minor units is the same value.
    expectEqual(moneyToMinor(moneyFromMinor(money.minor)), minor, `${input} round trips through minor units`);
  }

  // The forms the guard refuses.
  throws(() => moneyFromInput("125.00000"), "five decimal places are refused");
  throws(() => moneyFromInput("125.abc"), "a non-digit fraction is refused");
  throws(() => moneyFromInput(""), "an empty value is refused");
  throws(() => moneyFromInput("1e5"), "an exponent is refused");
  throws(() => moneyFromInput("1,250.00"), "a thousands separator is refused");
  throws(() => moneyFromInput("12.56789"), "five decimal places are refused the same way");
}

/** The balanced double-entry proof: a set of debits and credits sums to zero. */
function checkBalanced(): void {
  // A payment is a double entry: the payable is credited, the clearing is debited, and the two sides
  // are the same amount. The sum of the two postings is zero, which is what "balanced" means.
  const credit = moneyFromInput("100.0000");
  const debit = moneyNegate(credit);

  expectEqual(moneyAdd(credit, debit).minor, 0n, "a posting and its opposite balance to zero");

  // A settled period: the credits that came in, the debits that went out, and the fees. The set
  // balances - every debit has a credit somewhere in the book.
  const postings = [
    moneyFromInput("125.0000"), // the payment, a credit to the payable
    moneyFromInput("-6.2500"), // the platform fee, a debit
    moneyFromInput("-90.0000"), // the payout, a debit
    moneyFromInput("-28.7500"), // the reserve and the hold, debits
  ];

  const total = moneySum(postings);

  expectEqual(total.minor, 0n, "a balanced set of postings sums to zero");
  expect(moneyIsZero(total), "and the sum reads as zero");

  // And the two sides of one double entry are the same amount, opposite signs.
  const fee = moneyFromInput("6.2500");

  expectEqual(moneyCompare(fee, moneyNegate(moneyNegate(fee))), 0, "a double entry's two sides are the same amount");
  expectEqual(moneySign(fee), 1, "the credit side is positive");
  expectEqual(moneySign(moneyNegate(fee)), -1, "and the debit side is negative");
}

/** The range guard: a value past the database's ceiling is refused at construction. */
function checkRange(): void {
  const maximum = moneyFromInput("99999999999999.9999");

  expectEqual(maximum.minor, MAXIMUM_MINOR, "the ceiling is accepted");

  throws(() => moneyFromInput("100000000000000.0000"), "one step past the ceiling is refused");
  throws(() => moneyFromMinor(MAXIMUM_MINOR + 1n), "a minor value past the ceiling is refused");
  throws(() => moneyFromMinor(-(MAXIMUM_MINOR + 1n)), "and a value past the negative ceiling is refused too");
}

/* ---- the run ---- */

function run(): void {
  checkCurrencyGuard();
  checkDecimalExactness();
  checkArithmetic();
  checkRoundTrip();
  checkBalanced();
  checkRange();

  if (failures.length > 0) {
    process.stderr.write(`payments money gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `payments money gate passed: ${String(checks)} checks, an exact decimal on whole minor units, ` +
      `a currency guard closed on the one currency the platform carries, and a balanced set of ` +
      `double-entry postings that sums to zero\n`,
  );
}

run();
