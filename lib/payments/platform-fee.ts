// path: lib/payments/platform-fee.ts

/**
 * The payment core's platform fee: the percentage the platform keeps from every transaction, and the
 * balanced ledger group that posts it.
 *
 * ## What the fee is
 *
 * Section 10 of the feature list says "platform fee percent is set by super_admin, globally and per
 * sub-merchant when needed." The fee is a percentage of the transaction amount. When a payment is
 * captured, the platform keeps its fee: the merchant's payable is debited by the fee amount, and the
 * platform's fee income is credited by the same amount. The group balances because the debit and the
 * credit are the same number.
 *
 * ## How the fee is calculated
 *
 * The fee is calculated in whole minor units: `fee = (amount * basisPoints) / 10000`. The rate is in
 * basis points (290 means 2.9%). The division is integer division, so the fee is always a whole number
 * of minor units. A rate of 290 on an amount of 10000 produces a fee of 290. A rate of 290 on an
 * amount of 105 produces a fee of 3 (the fractional part is truncated).
 *
 * ## What this file is not
 *
 * It is not the fee configuration. The rate is set by the super admin and stored in the database. This
 * file calculates the fee from a rate and posts it. It is not the settlement (STEP 136 owns that), the
 * reserve, or the payout. It is not the API route or the UI. This file is the calculation and the
 * posting.
 */

import { randomUUID } from "node:crypto";
import { postLedgerEntries, type LedgerEntryStore, type LedgerPostingResult } from "./ledger-posting.ts";

/** One basis point: 0.01%. A rate of 290 means 2.9%. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/** The default platform fee rate in basis points: 2.9%. */
export const DEFAULT_PLATFORM_FEE_BPS = 290;

/** The closed range of fee rates the platform accepts: 0 to 10000 basis points (0% to 100%). */
export const MIN_FEE_BPS = 0;
export const MAX_FEE_BPS = 10_000;

/** Calculate the platform fee in minor units from an amount and a rate in basis points. */
export function calculatePlatformFee(amountMinor: bigint, basisPoints: number): bigint {
  return (amountMinor * BigInt(basisPoints)) / BigInt(BASIS_POINTS_PER_UNIT);
}

/** Post the platform fee for a transaction as a balanced ledger group. */
export function postPlatformFee(
  amountMinor: bigint,
  basisPoints: number,
  options: {
    readonly store: LedgerEntryStore;
    readonly companyId: string;
    readonly sourceId: string;
    readonly paymentId: string;
  },
): LedgerPostingResult {
  if (basisPoints < MIN_FEE_BPS || basisPoints > MAX_FEE_BPS) {
    return {
      status: "rejected",
      reason: `the platform fee rate must be between ${MIN_FEE_BPS} and ${MAX_FEE_BPS} basis points`,
    };
  }

  const fee = calculatePlatformFee(amountMinor, basisPoints);

  if (fee === 0n) {
    return { status: "rejected", reason: "the platform fee is zero, nothing to post" };
  }

  return postLedgerEntries(
    {
      companyId: options.companyId,
      entryGroupId: randomUUID(),
      sourceType: "platform_fee",
      sourceId: options.sourceId,
      paymentId: options.paymentId,
      refundId: null,
      disputeId: null,
      description: null,
      postings: [
        { accountId: "merchant_payable", entrySide: "debit", amountMinor: fee },
        { accountId: "platform_fee_income", entrySide: "credit", amountMinor: fee },
      ],
    },
    { store: options.store },
  );
}
