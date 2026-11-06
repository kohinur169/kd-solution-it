// path: lib/payments/settlement-release-verify.ts
import process from "node:process";
import {
  InMemorySettlementReleaseStore,
  runSettlementReleaseJob,
} from "./settlement-release.ts";
import {
  InMemorySettlementHoldStore,
  createSettlementHold,
} from "./settlement-hold.ts";
import { InMemoryLedgerEntryStore } from "./ledger-posting.ts";

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
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Create a settlement hold. Returns the hold id. */
function makeHold(
  holdStore: InMemorySettlementHoldStore,
  ledgerStore: InMemoryLedgerEntryStore,
  companyId: string,
  amountMinor: bigint,
  holdDays: number,
): string {
  const result = createSettlementHold(amountMinor, holdDays, {
    holdStore,
    ledgerStore,
    companyId,
    capturedAtEpochMs: capturedAt,
  });
  if (result.status !== "created") {
    throw new Error("failed to create settlement hold for test");
  }
  return result.hold.id;
}

/* ---- scenario 1: the job releases a due hold ---- */

const store1 = new InMemorySettlementReleaseStore();
const holdStore1 = new InMemorySettlementHoldStore();
const ledgerStore1 = new InMemoryLedgerEntryStore();
const holdId1 = makeHold(holdStore1, ledgerStore1, "company-1", 50_000n, 0);
const result1 = runSettlementReleaseJob({
  store: store1,
  holdStore: holdStore1,
  ledgerStore: ledgerStore1,
  nowEpochMs: capturedAt,
});

expect(result1.status === "completed", "the job completes");
if (result1.status === "completed") {
  expect(result1.releasedCount === 1, "the job releases one due hold");
}

/* ---- scenario 2: the released hold is marked as released ---- */

expect(holdStore1.findById(holdId1)?.status === "released", "the released hold is marked as released");

/* ---- scenario 3: a release record is created ---- */

if (result1.status === "completed") {
  expect(result1.records.length === 1, "a release record is created for the released hold");
  if (result1.records.length === 1) {
    expect(result1.records[0]?.companyId === "company-1", "the release record carries the right company");
    expect(result1.records[0]?.holdId === holdId1, "the release record carries the right hold id");
    expect(result1.records[0]?.amountMinor === 50_000n, "the release record carries the right amount");
    expect(result1.records[0]?.releasedAtEpochMs === capturedAt, "the release record carries the right time");
  }
}

/* ---- scenario 4: the release record is stored ---- */

if (result1.status === "completed" && result1.records.length === 1) {
  expect(store1.findById(result1.records[0]?.id ?? "") !== null, "the release record is stored in the store");
  expect(store1.findByHoldId(holdId1) !== null, "the release record is findable by hold id");
  expect(store1.findByCompany("company-1").length === 1, "the release record is findable by company");
}

/* ---- scenario 5: a hold that is not yet due is not released ---- */

const store5 = new InMemorySettlementReleaseStore();
const holdStore5 = new InMemorySettlementHoldStore();
const ledgerStore5 = new InMemoryLedgerEntryStore();
const holdId5 = makeHold(holdStore5, ledgerStore5, "company-1", 30_000n, 1);
const result5 = runSettlementReleaseJob({
  store: store5,
  holdStore: holdStore5,
  ledgerStore: ledgerStore5,
  nowEpochMs: capturedAt,
});

if (result5.status === "completed") {
  expect(result5.releasedCount === 0, "a hold that is not yet due is not released");
}
expect(holdStore5.findById(holdId5)?.status === "held", "the not-due hold stays in the held state");
expect(store5.findByCompany("company-1").length === 0, "no release record is created for a not-due hold");

/* ---- scenario 6: a hold that becomes due is released ---- */

const store6 = new InMemorySettlementReleaseStore();
const holdStore6 = new InMemorySettlementHoldStore();
const ledgerStore6 = new InMemoryLedgerEntryStore();
const holdId6 = makeHold(holdStore6, ledgerStore6, "company-1", 30_000n, 1);
const result6 = runSettlementReleaseJob({
  store: store6,
  holdStore: holdStore6,
  ledgerStore: ledgerStore6,
  nowEpochMs: capturedAt + MILLISECONDS_PER_DAY + 1_000,
});

if (result6.status === "completed") {
  expect(result6.releasedCount === 1, "a hold that becomes due is released");
}
expect(holdStore6.findById(holdId6)?.status === "released", "the due hold is marked as released");

/* ---- scenario 7: multiple holds from the same company are released in one run ---- */

const store7 = new InMemorySettlementReleaseStore();
const holdStore7 = new InMemorySettlementHoldStore();
const ledgerStore7 = new InMemoryLedgerEntryStore();
const holdId7a = makeHold(holdStore7, ledgerStore7, "company-1", 20_000n, 0);
const holdId7b = makeHold(holdStore7, ledgerStore7, "company-1", 30_000n, 0);
const result7 = runSettlementReleaseJob({
  store: store7,
  holdStore: holdStore7,
  ledgerStore: ledgerStore7,
  nowEpochMs: capturedAt,
});

if (result7.status === "completed") {
  expect(result7.releasedCount === 2, "two holds from the same company are released in one run");
}
expect(holdStore7.findById(holdId7a)?.status === "released", "the first hold is released");
expect(holdStore7.findById(holdId7b)?.status === "released", "the second hold is released");
expect(store7.findByCompany("company-1").length === 2, "two release records are stored for the same company");

/* ---- scenario 8: running the job twice does not release the same holds again ---- */

const store8 = new InMemorySettlementReleaseStore();
const holdStore8 = new InMemorySettlementHoldStore();
const ledgerStore8 = new InMemoryLedgerEntryStore();
makeHold(holdStore8, ledgerStore8, "company-1", 15_000n, 0);

const result8a = runSettlementReleaseJob({
  store: store8,
  holdStore: holdStore8,
  ledgerStore: ledgerStore8,
  nowEpochMs: capturedAt,
});
const result8b = runSettlementReleaseJob({
  store: store8,
  holdStore: holdStore8,
  ledgerStore: ledgerStore8,
  nowEpochMs: capturedAt + 1_000,
});

if (result8a.status === "completed") {
  expect(result8a.releasedCount === 1, "the first job run releases the hold");
}
if (result8b.status === "completed") {
  expect(result8b.releasedCount === 0, "the second job run does not release the same hold again");
}
expect(store8.findByCompany("company-1").length === 1, "only one release record exists after two runs");

/* ---- scenario 9: two release records have different ids ---- */

if (result7.status === "completed" && result7.records.length === 2) {
  expect(result7.records[0]?.id !== result7.records[1]?.id, "two release records have different ids");
}

/* ---- scenario 10: the release record carries the right amount ---- */

const store10 = new InMemorySettlementReleaseStore();
const holdStore10 = new InMemorySettlementHoldStore();
const ledgerStore10 = new InMemoryLedgerEntryStore();
const holdId10 = makeHold(holdStore10, ledgerStore10, "company-1", 100_000n, 0);
const result10 = runSettlementReleaseJob({
  store: store10,
  holdStore: holdStore10,
  ledgerStore: ledgerStore10,
  nowEpochMs: capturedAt,
});

if (result10.status === "completed" && result10.records.length === 1) {
  expect(result10.records[0]?.amountMinor === 100_000n, "the release record carries the full hold amount");
  expect(store10.findByHoldId(holdId10)?.amountMinor === 100_000n, "the stored record carries the right amount");
}

/* ---- scenario 11: holds from different companies are released independently ---- */

const store11 = new InMemorySettlementReleaseStore();
const holdStore11 = new InMemorySettlementHoldStore();
const ledgerStore11 = new InMemoryLedgerEntryStore();
const holdId11a = makeHold(holdStore11, ledgerStore11, "company-a", 10_000n, 0);
const holdId11b = makeHold(holdStore11, ledgerStore11, "company-b", 20_000n, 0);
const result11 = runSettlementReleaseJob({
  store: store11,
  holdStore: holdStore11,
  ledgerStore: ledgerStore11,
  nowEpochMs: capturedAt,
});

if (result11.status === "completed") {
  expect(result11.releasedCount === 2, "holds from different companies are released in one run");
}
expect(store11.findByCompany("company-a").length === 1, "company-a has one release record");
expect(store11.findByCompany("company-b").length === 1, "company-b has one release record");
expect(store11.findByHoldId(holdId11a)?.companyId === "company-a", "the record for company-a carries the right company");
expect(store11.findByHoldId(holdId11b)?.companyId === "company-b", "the record for company-b carries the right company");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments settlement release gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments settlement release gate passed: ${checks} checks, a background job that releases due settlement holds after their hold period ends - the job finds every held hold whose release time has come, releases it through the settlement hold service, and records what it released; a hold that is not yet due stays held, a second run does not re-release, and holds from different companies are released independently\n`,
);
