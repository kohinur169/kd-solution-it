// path: lib/payments/platform-fee-verify.ts
import process from "node:process";
import { InMemoryLedgerEntryStore } from "./ledger-posting.ts";
import {
  calculatePlatformFee,
  postPlatformFee,
  DEFAULT_PLATFORM_FEE_BPS,
  MIN_FEE_BPS,
  MAX_FEE_BPS,
  BASIS_POINTS_PER_UNIT,
} from "./platform-fee.ts";

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

/* ---- scenario 1: the fee is calculated correctly ---- */

expect(calculatePlatformFee(10_000n, 290) === 290n, "a 2.9% fee on 10000 minor units is 290");
expect(calculatePlatformFee(1_000_000n, 290) === 29_000n, "a 2.9% fee on 1000000 minor units is 29000");
expect(calculatePlatformFee(105n, 290) === 3n, "a 2.9% fee on 105 minor units is 3 (truncated)");
expect(calculatePlatformFee(12_345n, 290) === 358n, "a 2.9% fee on 12345 minor units is 358");
expect(calculatePlatformFee(10_000n, 10_000) === 10_000n, "a 100% fee equals the amount");
expect(calculatePlatformFee(10_000n, 0) === 0n, "a 0% fee is zero");
expect(calculatePlatformFee(0n, 290) === 0n, "a fee on a zero amount is zero");

/* ---- scenario 2: the fee group is posted and balanced ---- */

const store = new InMemoryLedgerEntryStore();
const feeResult = postPlatformFee(10_000n, 290, {
  store,
  companyId: "company-1",
  sourceId: "source-1",
  paymentId: "payment-1",
});

expect(feeResult.status === "posted", "the platform fee group is posted");

const feeEntries = feeResult.status === "posted" ? feeResult.entries : [];
expect(feeEntries.length === 2, "the fee group has two entries");

const feeDebit = feeEntries.find((entry) => entry.entrySide === "debit");
const feeCredit = feeEntries.find((entry) => entry.entrySide === "credit");

expect(feeDebit?.accountId === "merchant_payable", "the debit goes to merchant_payable");
expect(feeCredit?.accountId === "platform_fee_income", "the credit goes to platform_fee_income");
expect(feeDebit?.amountMinor === feeCredit?.amountMinor, "the debit and credit are the same amount");
expect(feeDebit?.amountMinor === 290n, "the fee amount is 290 minor units");

/* ---- scenario 3: the fee group carries the right metadata ---- */

expect(
  feeEntries.every((entry) => entry.sourceType === "platform_fee"),
  "every fee entry carries the platform_fee source type",
);
expect(
  feeEntries.every((entry) => entry.companyId === "company-1"),
  "every fee entry is scoped to the company",
);
expect(
  feeEntries.every((entry) => entry.paymentId === "payment-1"),
  "every fee entry carries the payment id",
);
expect(
  feeEntries.every((entry) => entry.currency === "USD"),
  "every fee entry carries USD",
);
expect(
  feeEntries.every((entry) => entry.reversalOfId === null),
  "no fee entry is a reversal",
);

/* ---- scenario 4: the fee group is its own balanced group ---- */

const feeGroupId = feeEntries[0]?.entryGroupId;
expect(feeGroupId !== undefined, "the fee group has an id");
expect(feeGroupId !== undefined && feeGroupId !== "payment-group", "the fee group is separate from the payment group");

const feeDebits = feeEntries
  .filter((entry) => entry.entrySide === "debit")
  .reduce((total, entry) => total + entry.amountMinor, 0n);
const feeCredits = feeEntries
  .filter((entry) => entry.entrySide === "credit")
  .reduce((total, entry) => total + entry.amountMinor, 0n);
expect(feeDebits === feeCredits, "the fee group balances");
expect(feeDebits === 290n, "the fee group debits are 290");

/* ---- scenario 5: a zero fee is refused ---- */

const zeroFeeStore = new InMemoryLedgerEntryStore();
const zeroFeeResult = postPlatformFee(10_000n, 0, {
  store: zeroFeeStore,
  companyId: "company-1",
  sourceId: "source-1",
  paymentId: "payment-1",
});
expect(zeroFeeResult.status === "rejected", "a zero fee is refused");
expect(zeroFeeStore.listGroupIds().length === 0, "nothing is posted for a zero fee");

/* ---- scenario 6: an out-of-range rate is refused ---- */

const badRateStore = new InMemoryLedgerEntryStore();
const badRateResult = postPlatformFee(10_000n, 10_001, {
  store: badRateStore,
  companyId: "company-1",
  sourceId: "source-1",
  paymentId: "payment-1",
});
expect(badRateResult.status === "rejected", "an out-of-range rate is refused");

const negativeRateStore = new InMemoryLedgerEntryStore();
const negativeRateResult = postPlatformFee(10_000n, -1, {
  store: negativeRateStore,
  companyId: "company-1",
  sourceId: "source-1",
  paymentId: "payment-1",
});
expect(negativeRateResult.status === "rejected", "a negative rate is refused");

/* ---- scenario 7: the fee entries are in the store ---- */

expect(store.findByGroup(feeGroupId ?? "").length === 2, "the store holds the fee entries");

/* ---- scenario 8: the constants are correct ---- */

expect(DEFAULT_PLATFORM_FEE_BPS === 290, "the default rate is 290 basis points");
expect(MIN_FEE_BPS === 0, "the minimum rate is 0 basis points");
expect(MAX_FEE_BPS === 10_000, "the maximum rate is 10000 basis points");
expect(BASIS_POINTS_PER_UNIT === 10_000, "one unit is 10000 basis points");

/* ---- scenario 9: the fee is a whole number of minor units ---- */

const fee = calculatePlatformFee(12_345n, 290);
expect(typeof fee === "bigint", "the fee is a whole number of minor units");
expect(fee === 358n, "a 2.9% fee on 12345 minor units is 358");

/* ---- scenario 10: the fee is positive for a normal transaction ---- */

expect(fee > 0n, "the fee is positive for a non-zero amount and rate");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments platform fee gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments platform fee gate passed: ${checks} checks, a fee service that calculates the platform's percentage of every transaction and posts it as a balanced ledger group - the merchant's payable is debited and the platform's fee income is credited by the same amount, the fee is a whole number of minor units, and a zero fee is refused\n`,
);
