// path: lib/payments/reserve-verify.ts
import process from "node:process";
import { InMemoryLedgerEntryStore } from "./ledger-posting.ts";
import {
  InMemoryReserveHoldStore,
  postReserve,
  releaseReserve,
  releaseReserves,
  calculateReserve,
  DEFAULT_RESERVE_BPS,
  DEFAULT_RESERVE_DAYS,
  MILLISECONDS_PER_DAY,
} from "./reserve.ts";

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

const capturedAt = 1_000_000_000_000;
const nowAfterThirtyDays = capturedAt + 30 * MILLISECONDS_PER_DAY;
const nowAfterThirtyOneDays = capturedAt + 31 * MILLISECONDS_PER_DAY;

/* ---- scenario 1: the reserve is calculated correctly ---- */

expect(calculateReserve(10_000n, 500) === 500n, "a 5% reserve on 10000 minor units is 500");
expect(calculateReserve(1_000_000n, 500) === 50_000n, "a 5% reserve on 1000000 minor units is 50000");
expect(calculateReserve(105n, 500) === 5n, "a 5% reserve on 105 minor units is 5 (truncated)");
expect(calculateReserve(10_000n, 0) === 0n, "a 0% reserve is zero");

/* ---- scenario 2: the reserve group is posted and balanced ---- */

const holdStore = new InMemoryReserveHoldStore();
const ledgerStore = new InMemoryLedgerEntryStore();
const holdResult = postReserve(10_000n, 500, 30, {
  holdStore,
  ledgerStore,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});

expect(holdResult.status === "created", "a reserve hold is posted");

const hold = holdResult.status === "created" ? holdResult.hold : null;
expect(hold?.amountMinor === 500n, "the hold carries the right reserve amount");
expect(hold?.reserveDays === 30, "the hold carries the right release period");
expect(hold?.companyId === "company-1", "the hold carries the right company");
expect(hold?.status === "held", "the hold starts in the held state");
expect(
  hold?.releaseAtEpochMs === capturedAt + 30 * MILLISECONDS_PER_DAY,
  "the release date is captured-at plus reserve-days",
);

/* ---- scenario 3: the reserve group posts a balanced ledger group ---- */

expect(ledgerStore.listGroupIds().length >= 1, "the reserve posts a ledger group");

let reserveGroupBalanced = false;
for (const groupId of ledgerStore.listGroupIds()) {
  const entries = ledgerStore.findByGroup(groupId);
  if (entries.every((entry) => entry.sourceType === "reserve")) {
    const debits = entries.filter((entry) => entry.entrySide === "debit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const credits = entries.filter((entry) => entry.entrySide === "credit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const debitAccounts = entries.filter((entry) => entry.entrySide === "debit").map((entry) => entry.accountId);
    const creditAccounts = entries.filter((entry) => entry.entrySide === "credit").map((entry) => entry.accountId);
    if (debits === credits && debits === 500n && debitAccounts[0] === "merchant_payable" && creditAccounts[0] === "reserve_held") {
      reserveGroupBalanced = true;
    }
  }
}
expect(reserveGroupBalanced, "the reserve group balances with debit to merchant_payable and credit to reserve_held");

/* ---- scenario 4: a zero reserve is refused ---- */

const zeroRateStore = new InMemoryReserveHoldStore();
const zeroRateLedger = new InMemoryLedgerEntryStore();
const zeroRateResult = postReserve(10_000n, 0, 30, {
  holdStore: zeroRateStore,
  ledgerStore: zeroRateLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(zeroRateResult.status === "rejected", "a zero reserve rate is refused");

/* ---- scenario 5: an out-of-range rate is refused ---- */

const badRateStore = new InMemoryReserveHoldStore();
const badRateLedger = new InMemoryLedgerEntryStore();
const badRateResult = postReserve(10_000n, 10_001, 30, {
  holdStore: badRateStore,
  ledgerStore: badRateLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(badRateResult.status === "rejected", "an out-of-range reserve rate is refused");

/* ---- scenario 6: a negative release period is refused ---- */

const negativeDaysStore = new InMemoryReserveHoldStore();
const negativeDaysLedger = new InMemoryLedgerEntryStore();
const negativeDaysResult = postReserve(10_000n, 500, -1, {
  holdStore: negativeDaysStore,
  ledgerStore: negativeDaysLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(negativeDaysResult.status === "rejected", "a negative reserve release period is refused");

/* ---- scenario 7: a reserve is not releaseable before the release date ---- */

expect(holdStore.findReleaseable(capturedAt).length === 0, "a reserve is not releaseable at the capture time");
expect(
  holdStore.findReleaseable(capturedAt + 29 * MILLISECONDS_PER_DAY).length === 0,
  "a reserve is not releaseable before the release date",
);

/* ---- scenario 8: a reserve is releaseable after the release date ---- */

expect(holdStore.findReleaseable(nowAfterThirtyDays).length === 1, "a reserve is releaseable at the release date");
expect(holdStore.findReleaseable(nowAfterThirtyOneDays).length === 1, "a reserve is releaseable after the release date");

/* ---- scenario 9: a zero-day reserve is immediately releaseable ---- */

const zeroDayStore = new InMemoryReserveHoldStore();
const zeroDayLedger = new InMemoryLedgerEntryStore();
const zeroDayResult = postReserve(10_000n, 500, 0, {
  holdStore: zeroDayStore,
  ledgerStore: zeroDayLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(zeroDayResult.status === "created", "a zero-day reserve is posted");
expect(zeroDayStore.findReleaseable(capturedAt).length === 1, "a zero-day reserve is immediately releaseable");

/* ---- scenario 10: a reserve can be released individually ---- */

expect(releaseReserve(hold?.id ?? "", { holdStore, ledgerStore, nowEpochMs: capturedAt }) === null, "reserve cannot be released before maturity");
expect(postReserve(10_000n, NaN, 30, { holdStore, ledgerStore, companyId: "company-1", capturedAtEpochMs: capturedAt }).status === "rejected", "invalid reserve rate is rejected");
expect(postReserve(10_000n, 500, 0.5, { holdStore, ledgerStore, companyId: "company-1", capturedAtEpochMs: capturedAt }).status === "rejected", "fractional reserve period is rejected");
const releaseResult = releaseReserve(hold?.id ?? "", { holdStore, ledgerStore, nowEpochMs: nowAfterThirtyDays });
expect(releaseResult !== null, "a reserve can be released individually");
expect(releaseResult?.status === "released", "the released reserve has the released status");

/* ---- scenario 11: a reserve that does not exist cannot be released ---- */

const missingResult = releaseReserve("nonexistent-id", { holdStore, ledgerStore, nowEpochMs: nowAfterThirtyDays });
expect(missingResult === null, "a reserve that does not exist cannot be released");

/* ---- scenario 12: an already-released reserve is not released again ---- */

const againResult = releaseReserve(hold?.id ?? "", { holdStore, ledgerStore, nowEpochMs: nowAfterThirtyDays });
expect(againResult?.status === "released", "an already-released reserve stays released");
expect(againResult?.releaseAtEpochMs === hold?.releaseAtEpochMs, "the already-released reserve keeps its release date");

/* ---- scenario 13: a released reserve is not returned by findReleaseable ---- */

expect(holdStore.findReleaseable(nowAfterThirtyOneDays).length === 0, "a released reserve is not returned by findReleaseable");

/* ---- scenario 14: the batch job releases all ready reserves ---- */

const batchStore = new InMemoryReserveHoldStore();
const batchLedger = new InMemoryLedgerEntryStore();
postReserve(10_000n, 500, 10, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
postReserve(20_000n, 500, 10, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
postReserve(30_000n, 500, 50, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
const released = releaseReserves({
  holdStore: batchStore,
  ledgerStore: batchLedger,
  nowEpochMs: capturedAt + 11 * MILLISECONDS_PER_DAY,
});
expect(released.length === 2, "the batch job releases two ready reserves");
expect(batchStore.findReleaseable(capturedAt + 11 * MILLISECONDS_PER_DAY).length === 0, "no reserves are releaseable after the batch");

/* ---- scenario 15: the release group balances with the opposite accounts ---- */

let releaseGroupBalanced = false;
for (const groupId of ledgerStore.listGroupIds()) {
  const entries = ledgerStore.findByGroup(groupId);
  if (entries.every((entry) => entry.sourceType === "reserve")) {
    const debits = entries.filter((entry) => entry.entrySide === "debit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const credits = entries.filter((entry) => entry.entrySide === "credit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const debitAccounts = entries.filter((entry) => entry.entrySide === "debit").map((entry) => entry.accountId);
    const creditAccounts = entries.filter((entry) => entry.entrySide === "credit").map((entry) => entry.accountId);
    if (
      debits === credits &&
      debits === 500n &&
      debitAccounts[0] === "reserve_held" &&
      creditAccounts[0] === "merchant_payable"
    ) {
      releaseGroupBalanced = true;
    }
  }
}
expect(releaseGroupBalanced, "the release group balances with debit to reserve_held and credit to merchant_payable");

/* ---- scenario 16: the constants are correct ---- */

expect(DEFAULT_RESERVE_BPS === 500, "the default reserve rate is 500 basis points");
expect(DEFAULT_RESERVE_DAYS === 30, "the default reserve release period is 30 days");
expect(MILLISECONDS_PER_DAY === 86_400_000, "one day is 86400000 milliseconds");

/* ---- scenario 17: the hold is stored in the store ---- */

expect(holdStore.findById(hold?.id ?? "")?.id === hold?.id, "the hold is stored in the store");

/* ---- scenario 18: two holds have different ids ---- */

const hold2Result = postReserve(10_000n, 500, 30, {
  holdStore,
  ledgerStore,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(hold2Result.status === "created" && hold2Result.hold.id !== hold?.id, "two holds have different ids");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments reserve gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments reserve gate passed: ${checks} checks, a rolling reserve that holds back a percentage of every transaction as risk protection and a scheduled release that returns it after the configured number of days - the reserve posts a balanced group (debit merchant_payable, credit reserve_held), the release posts a mirror (debit reserve_held, credit merchant_payable), and a released reserve is never released again\n`,
);
