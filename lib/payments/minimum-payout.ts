// path: lib/payments/minimum-payout.ts

/**
 * The payment core's minimum payout threshold: the rule that gates payouts at 100 USD and the remainder
 * rule that releases sub-minimum balances after the holding period.
 *
 * ## What the threshold is
 *
 * Section 10 says "minimum payout amount is 100 USD. Below that amount, funds are paid out as the
 * accumulated remainder after the holding period." A payout cannot be made for less than 100 USD during
 * normal operations. If the available balance is below 100 USD, the funds stay in the merchant's balance
 * and accumulate — they are not lost, they are held.
 *
 * The remainder rule is the release valve. After the settlement holding period (STEP 136) ends, if the
 * accumulated balance is still below 100 USD, the platform pays it out anyway. The merchant is never
 * stranded with money they cannot withdraw because they are a few dollars short of the threshold. The
 * `allowRemainder` flag distinguishes the two paths: false for a normal payout check, true for a
 * remainder payout after the holding period.
 *
 * ## What this file is not
 *
 * It is not the settlement hold calculation (STEP 136 owns that). It is not the payout execution
 * (STEP 143 owns that). It is not the API route or UI. This file is the core rule: the threshold
 * constant, the calculation, and the can-payout check.
 */

/** The minimum payout amount: 100 USD in minor units (cents). */
export const MINIMUM_PAYOUT_MINOR = 100n * 100n;

/** The result of calculating a payout amount. */
export type PayoutDecision =
  | { status: "payout"; amountMinor: bigint }
  | { status: "hold"; reason: string; availableMinor: bigint };

/** Calculate the payout amount: the full balance when eligible, a hold reason when not. */
export function calculatePayoutAmount(
  availableMinor: bigint,
  options: {
    /** Whether the remainder rule applies: true after the holding period, false during normal operations. */
    readonly allowRemainder: boolean;
  },
): PayoutDecision {
  // 1. A zero or negative balance is never paid out.
  if (availableMinor <= 0n) {
    return {
      status: "hold",
      reason: availableMinor === 0n ? "available balance is zero" : "available balance must not be negative",
      availableMinor,
    };
  }

  // 2. The remainder rule: below the minimum, the accumulated remainder is paid out after the holding period.
  if (options.allowRemainder) {
    return { status: "payout", amountMinor: availableMinor };
  }

  // 3. Normal payout: only the minimum or more can be paid out.
  if (availableMinor >= MINIMUM_PAYOUT_MINOR) {
    return { status: "payout", amountMinor: availableMinor };
  }

  return {
    status: "hold",
    reason: `available balance ${availableMinor} is below the minimum payout of ${MINIMUM_PAYOUT_MINOR}`,
    availableMinor,
  };
}

/** Check whether a payout can be made for the given available balance. */
export function canPayout(
  availableMinor: bigint,
  options: {
    readonly allowRemainder: boolean;
  },
): boolean {
  return calculatePayoutAmount(availableMinor, options).status === "payout";
}
