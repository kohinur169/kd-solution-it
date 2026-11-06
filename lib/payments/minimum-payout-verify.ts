// path: lib/payments/minimum-payout-verify.ts
import process from "node:process";
import { moneyFromInput } from "./money.ts";
import {
  MINIMUM_PAYOUT_MINOR,
  calculatePayoutAmount,
  canPayout,
} from "./minimum-payout.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    checks++;
  } else {
    failures.push(description);
  }
}

/* ---- scenario 1: a balance above the minimum can be paid out (normal) ---- */

const aboveMin = calculatePayoutAmount(5_000_000n, { allowRemainder: false });
expect(aboveMin.status === "payout", "a balance above the minimum can be paid out during normal operations");
if (aboveMin.status === "payout") {
  expect(aboveMin.amountMinor === 5_000_000n, "the payout amount equals the available balance");
}

/* ---- scenario 2: a balance below the minimum cannot be paid out (normal) ---- */

const belowMin = calculatePayoutAmount(500_000n, { allowRemainder: false });
expect(belowMin.status === "hold", "a balance below the minimum cannot be paid out during normal operations");
if (belowMin.status === "hold") {
  expect(belowMin.availableMinor === 500_000n, "the hold carries the available amount");
  expect(belowMin.reason.includes("below the minimum"), "the hold reason mentions the minimum");
}

/* ---- scenario 3: a balance above the minimum can be paid out (remainder) ---- */

const aboveMinRemainder = calculatePayoutAmount(5_000_000n, { allowRemainder: true });
expect(aboveMinRemainder.status === "payout", "a balance above the minimum can be paid out under the remainder rule");

/* ---- scenario 4: a balance below the minimum can be paid out (remainder) ---- */

const belowMinRemainder = calculatePayoutAmount(500_000n, { allowRemainder: true });
expect(belowMinRemainder.status === "payout", "a balance below the minimum can be paid out under the remainder rule");
if (belowMinRemainder.status === "payout") {
  expect(belowMinRemainder.amountMinor === 500_000n, "the remainder payout amount equals the available balance");
}

/* ---- scenario 5: a zero balance cannot be paid out ---- */

const zero = calculatePayoutAmount(0n, { allowRemainder: false });
expect(zero.status === "hold", "a zero balance cannot be paid out during normal operations");

/* ---- scenario 6: a zero balance cannot be paid out (remainder) ---- */

const zeroRemainder = calculatePayoutAmount(0n, { allowRemainder: true });
expect(zeroRemainder.status === "hold", "a zero balance cannot be paid out under the remainder rule");

/* ---- scenario 7: a negative balance cannot be paid out ---- */

const negative = calculatePayoutAmount(-100n, { allowRemainder: false });
expect(negative.status === "hold", "a negative balance cannot be paid out");

/* ---- scenario 8: the minimum payout constant is 100 USD ---- */

expect(moneyFromInput("100.00", "USD").minor === MINIMUM_PAYOUT_MINOR, "the threshold matches the platform money scale");
expect(MINIMUM_PAYOUT_MINOR === 1_000_000n, "the minimum payout is 1,000,000 four-decimal units (100 USD)");

/* ---- scenario 9: exactly 100 USD can be paid out ---- */

const exactMin = calculatePayoutAmount(1_000_000n, { allowRemainder: false });
expect(exactMin.status === "payout", "exactly 100 USD can be paid out during normal operations");

/* ---- scenario 10: 9,999 cents cannot be paid out (normal) ---- */

const justBelow = calculatePayoutAmount(999_900n, { allowRemainder: false });
expect(justBelow.status === "hold", "9,999 cents cannot be paid out during normal operations");

/* ---- scenario 11: 9,999 cents can be paid out (remainder) ---- */

const justBelowRemainder = calculatePayoutAmount(999_900n, { allowRemainder: true });
expect(justBelowRemainder.status === "payout", "9,999 cents can be paid out under the remainder rule");

/* ---- scenario 12: 10,001 cents can be paid out ---- */

const justAbove = calculatePayoutAmount(1_000_100n, { allowRemainder: false });
expect(justAbove.status === "payout", "10,001 cents can be paid out during normal operations");

/* ---- scenario 13: 1 cent can be paid out (remainder) ---- */

const oneCent = calculatePayoutAmount(100n, { allowRemainder: true });
expect(oneCent.status === "payout", "1 cent can be paid out under the remainder rule");

/* ---- scenario 14: 1 cent cannot be paid out (normal) ---- */

const oneCentNormal = calculatePayoutAmount(100n, { allowRemainder: false });
expect(oneCentNormal.status === "hold", "1 cent cannot be paid out during normal operations");

/* ---- scenario 15: 99 USD 99 cents cannot be paid out (normal) ---- */

const ninetyNine = calculatePayoutAmount(999_900n, { allowRemainder: false });
expect(ninetyNine.status === "hold", "99 USD 99 cents cannot be paid out during normal operations");

/* ---- scenario 16: 99 USD 99 cents can be paid out (remainder) ---- */

const ninetyNineRemainder = calculatePayoutAmount(999_900n, { allowRemainder: true });
expect(ninetyNineRemainder.status === "payout", "99 USD 99 cents can be paid out under the remainder rule");

/* ---- scenario 17: canPayout returns true when the calculation says payout ---- */

expect(canPayout(5_000_000n, { allowRemainder: false }) === true, "canPayout returns true for a balance above the minimum");
expect(canPayout(500_000n, { allowRemainder: true }) === true, "canPayout returns true for a below-minimum balance under the remainder rule");

/* ---- scenario 18: canPayout returns false when the calculation says hold ---- */

expect(canPayout(500_000n, { allowRemainder: false }) === false, "canPayout returns false for a below-minimum balance during normal operations");
expect(canPayout(0n, { allowRemainder: false }) === false, "canPayout returns false for a zero balance");

/* ---- scenario 19: the hold reason is descriptive ---- */

if (belowMin.status === "hold") {
  expect(belowMin.reason.includes("500000"), "the hold reason includes the available amount");
  expect(belowMin.reason.includes("1000000"), "the hold reason includes the minimum amount");
}

/* ---- scenario 20: a large balance is paid out in full ---- */

const large = calculatePayoutAmount(1_000_000n, { allowRemainder: false });
expect(large.status === "payout", "a large balance can be paid out");
if (large.status === "payout") {
  expect(large.amountMinor === 1_000_000n, "the payout amount equals the large balance");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments minimum payout gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments minimum payout gate passed: ${checks} checks, a rule that gates payouts at 100 USD and releases sub-minimum balances as the remainder after the holding period - a balance at or above the minimum is paid out during normal operations, a balance below the minimum is held, and the remainder rule pays out the full balance including sub-minimum amounts after the holding period\n`,
);
