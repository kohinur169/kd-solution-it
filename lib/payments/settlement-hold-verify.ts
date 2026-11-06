// path: lib/payments/settlement-hold-verify.ts
import process from "node:process";
import { InMemoryLedgerEntryStore } from "./ledger-posting.ts";
import {
  InMemorySettlementHoldStore,
  createSettlementHold,
  releaseSettlementHold,
  releaseSettlementHolds,
  MILLISECONDS_PER_DAY,
  DEFAULT_SETTLEMENT_HOLD_DAYS,
} from "./settlement-hold.ts";

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
const nowAtCapture = capturedAt;
const nowAfterTwoDays = capturedAt + 2 * MILLISECONDS_PER_DAY;
const nowAfterThreeDays = capturedAt + 3 * MILLISECONDS_PER_DAY;

/* ---- scenario 1: a hold is created with the right amount and hold period ---- */

const holdStore = new InMemorySettlementHoldStore();
const ledgerStore = new InMemoryLedgerEntryStore();
const holdResult = createSettlementHold(10_000n, 2, {
  holdStore,
  ledgerStore,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});

expect(holdResult.status === "created", "a settlement hold is created");

const hold = holdResult.status === "created" ? holdResult.hold : null;
expect(hold?.amountMinor === 10_000n, "the hold carries the right amount");
expect(hold?.holdDays === 2, "the hold carries the right hold period");
expect(hold?.companyId === "company-1", "the hold carries the right company");
expect(hold?.status === "held", "the hold starts in the held state");

/* ---- scenario 2: the release date is calculated correctly ---- */

expect(
  hold?.releaseAtEpochMs === capturedAt + 2 * MILLISECONDS_PER_DAY,
  "the release date is captured-at plus hold-days",
);

/* ---- scenario 3: a hold is not releaseable before the release date ---- */

expect(holdStore.findReleaseable(nowAtCapture).length === 0, "a hold is not releaseable at the capture time");
expect(
  holdStore.findReleaseable(capturedAt + MILLISECONDS_PER_DAY).length === 0,
  "a hold is not releaseable one day after capture",
);

/* ---- scenario 4: a hold is releaseable after the release date ---- */

expect(holdStore.findReleaseable(nowAfterTwoDays).length === 1, "a hold is releaseable at the release date");
expect(holdStore.findReleaseable(nowAfterThreeDays).length === 1, "a hold is releaseable after the release date");

/* ---- scenario 5: a hold with zero days is immediately releaseable ---- */

const zeroDayStore = new InMemorySettlementHoldStore();
const zeroDayLedger = new InMemoryLedgerEntryStore();
const zeroDayResult = createSettlementHold(5_000n, 0, {
  holdStore: zeroDayStore,
  ledgerStore: zeroDayLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(zeroDayResult.status === "created", "a zero-day hold is created");
expect(zeroDayStore.findReleaseable(capturedAt).length === 1, "a zero-day hold is immediately releaseable");

/* ---- scenario 6: a hold with a negative amount is rejected ---- */

const negativeStore = new InMemorySettlementHoldStore();
const negativeLedger = new InMemoryLedgerEntryStore();
const negativeResult = createSettlementHold(-1n, 2, {
  holdStore: negativeStore,
  ledgerStore: negativeLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(negativeResult.status === "rejected", "a negative amount is rejected");

/* ---- scenario 7: a hold with a negative number of days is rejected ---- */

const negativeDaysStore = new InMemorySettlementHoldStore();
const negativeDaysLedger = new InMemoryLedgerEntryStore();
const negativeDaysResult = createSettlementHold(10_000n, -1, {
  holdStore: negativeDaysStore,
  ledgerStore: negativeDaysLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(negativeDaysResult.status === "rejected", "a negative hold period is rejected");

/* ---- scenario 8: the release date is calculated correctly for different hold periods ---- */

const oneDayStore = new InMemorySettlementHoldStore();
const oneDayLedger = new InMemoryLedgerEntryStore();
const oneDayResult = createSettlementHold(1n, 1, {
  holdStore: oneDayStore,
  ledgerStore: oneDayLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(oneDayResult.status === "created", "a 1-day hold is created");
expect(
  oneDayResult.status === "created" && oneDayResult.hold.releaseAtEpochMs === capturedAt + MILLISECONDS_PER_DAY,
  "a 1-day hold releases one day after capture",
);

const sevenDayStore = new InMemorySettlementHoldStore();
const sevenDayLedger = new InMemoryLedgerEntryStore();
const sevenDayResult = createSettlementHold(1n, 7, {
  holdStore: sevenDayStore,
  ledgerStore: sevenDayLedger,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(sevenDayResult.status === "created", "a 7-day hold is created");
expect(
  sevenDayResult.status === "created" && sevenDayResult.hold.releaseAtEpochMs === capturedAt + 7 * MILLISECONDS_PER_DAY,
  "a 7-day hold releases seven days after capture",
);

/* ---- scenario 9: multiple holds can be created for the same company ---- */

const multiStore = new InMemorySettlementHoldStore();
const multiLedger = new InMemoryLedgerEntryStore();
createSettlementHold(1_000n, 2, { holdStore: multiStore, ledgerStore: multiLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
createSettlementHold(2_000n, 2, { holdStore: multiStore, ledgerStore: multiLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
expect(multiStore.findByCompany("company-1").length === 2, "two holds are stored for the same company");

/* ---- scenario 10: a hold can be released individually ---- */

const releaseResult = releaseSettlementHold(hold?.id ?? "", { holdStore, ledgerStore });
expect(releaseResult !== null, "a hold can be released individually");
expect(releaseResult?.status === "released", "the released hold has the released status");

/* ---- scenario 11: a hold that does not exist cannot be released ---- */

const missingResult = releaseSettlementHold("nonexistent-id", { holdStore, ledgerStore });
expect(missingResult === null, "a hold that does not exist cannot be released");

/* ---- scenario 12: a hold that is already released is not released again ---- */

const againResult = releaseSettlementHold(hold?.id ?? "", { holdStore, ledgerStore });
expect(againResult?.status === "released", "an already-released hold stays released");
expect(againResult?.releaseAtEpochMs === hold?.releaseAtEpochMs, "the already-released hold keeps its release date");

/* ---- scenario 13: a released hold is not returned by findReleaseable ---- */

expect(holdStore.findReleaseable(nowAfterThreeDays).length === 0, "a released hold is not returned by findReleaseable");

/* ---- scenario 14: releaseSettlementHolds releases all ready holds ---- */

const batchStore = new InMemorySettlementHoldStore();
const batchLedger = new InMemoryLedgerEntryStore();
createSettlementHold(1_000n, 1, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
createSettlementHold(2_000n, 1, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
createSettlementHold(3_000n, 5, { holdStore: batchStore, ledgerStore: batchLedger, companyId: "company-1", capturedAtEpochMs: capturedAt });
const released = releaseSettlementHolds({
  holdStore: batchStore,
  ledgerStore: batchLedger,
  nowEpochMs: capturedAt + 2 * MILLISECONDS_PER_DAY,
});
expect(released.length === 2, "the batch job releases two ready holds");
expect(batchStore.findReleaseable(capturedAt + 2 * MILLISECONDS_PER_DAY).length === 0, "no holds are releaseable after the batch release");

/* ---- scenario 15: the hold is stored in the store ---- */

expect(holdStore.findById(hold?.id ?? "")?.id === hold?.id, "the hold is stored in the store");

/* ---- scenario 16: two holds have different ids ---- */

const hold2Result = createSettlementHold(10_000n, 2, {
  holdStore,
  ledgerStore,
  companyId: "company-1",
  capturedAtEpochMs: capturedAt,
});
expect(hold2Result.status === "created" && hold2Result.hold.id !== hold?.id, "two holds have different ids");

/* ---- scenario 17: the hold posts a ledger group ---- */

expect(ledgerStore.listGroupIds().length >= 2, "the hold and the settlement each post a ledger group");

/* ---- scenario 18: the hold ledger group balances and carries the hold source type ---- */

let holdGroupBalanced = false;
for (const groupId of ledgerStore.listGroupIds()) {
  const entries = ledgerStore.findByGroup(groupId);
  if (entries.every((entry) => entry.sourceType === "hold")) {
    const debits = entries.filter((entry) => entry.entrySide === "debit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const credits = entries.filter((entry) => entry.entrySide === "credit").reduce((total, entry) => total + entry.amountMinor, 0n);
    if (debits === credits && debits === 10_000n) {
      holdGroupBalanced = true;
    }
  }
}
expect(holdGroupBalanced, "the hold ledger group balances with the right amount and source type");

/* ---- scenario 19: the settlement ledger group balances and carries the settlement source type ---- */

let settlementGroupBalanced = false;
for (const groupId of ledgerStore.listGroupIds()) {
  const entries = ledgerStore.findByGroup(groupId);
  if (entries.every((entry) => entry.sourceType === "settlement")) {
    const debits = entries.filter((entry) => entry.entrySide === "debit").reduce((total, entry) => total + entry.amountMinor, 0n);
    const credits = entries.filter((entry) => entry.entrySide === "credit").reduce((total, entry) => total + entry.amountMinor, 0n);
    if (debits === credits && debits === 10_000n) {
      settlementGroupBalanced = true;
    }
  }
}
expect(settlementGroupBalanced, "the settlement ledger group balances with the right amount and source type");

/* ---- scenario 20: the constants are correct ---- */

expect(MILLISECONDS_PER_DAY === 86_400_000, "one day is 86400000 milliseconds");
expect(DEFAULT_SETTLEMENT_HOLD_DAYS === 2, "the default hold period is 2 days");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments settlement hold gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments settlement hold gate passed: ${checks} checks, a hold that keeps captured funds in the ledger for the configured number of days and a scheduled release job that releases every hold whose period has passed - the hold posts a balanced group, the release posts a mirror, and a released hold is never released again\n`,
);
