// path: lib/payments/reconciliation-import-verify.ts
import process from "node:process";
import {
  importProcessorReport,
  type ProcessorReport,
  type SystemRecord,
  type SystemRecordLookup,
  type ReconciliationEntryType,
} from "./reconciliation-import.ts";

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

const periodStart = 1_000_000_000_000;
const periodEnd = 1_000_000_000_000 + 7 * 24 * 60 * 60 * 1000;

/** An in-memory system record lookup for the gate. */
class InMemorySystemRecordLookup implements SystemRecordLookup {
  private readonly records = new Map<string, SystemRecord>();

  add(record: SystemRecord): void {
    this.records.set(record.providerTransactionId, record);
  }

  findByProviderTransactionId(providerTransactionId: string): SystemRecord | null {
    return this.records.get(providerTransactionId) ?? null;
  }

  listByPeriod(_periodStartEpochMs: number, _periodEndEpochMs: number): SystemRecord[] {
    return [...this.records.values()];
  }
}

function makeReport(entries: { id: string; type: ReconciliationEntryType; amount: bigint }[]) {
  return {
    id: "report-1",
    providerName: "payoneer",
    periodStartEpochMs: periodStart,
    periodEndEpochMs: periodEnd,
    entries: entries.map((entry) => ({
      providerTransactionId: entry.id,
      type: entry.type,
      amountMinor: entry.amount,
    })),
  } as ProcessorReport;
}

/* ---- scenario 1: all entries match ---- */

const lookup1 = new InMemorySystemRecordLookup();
lookup1.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
lookup1.add({ providerTransactionId: "txn-002", type: "refund", amountMinor: 5_000n });
const result1 = importProcessorReport(makeReport([
  { id: "txn-001", type: "payment", amount: 10_000n },
  { id: "txn-002", type: "refund", amount: 5_000n },
]), { systemRecords: lookup1 });

expect(result1.matched === 2, "all matching entries are counted as matched");
expect(result1.systemOnly === 0, "no system-only entries when all match");
expect(result1.processorOnly === 0, "no processor-only entries when all match");
expect(result1.amountMismatches === 0, "no amount mismatches when all match");
expect(result1.totalEntries === 2, "the total entry count is correct");

/* ---- scenario 2: a processor-only entry ---- */

const lookup2 = new InMemorySystemRecordLookup();
lookup2.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
const result2 = importProcessorReport(makeReport([
  { id: "txn-001", type: "payment", amount: 10_000n },
  { id: "txn-999", type: "payment", amount: 7_000n },
]), { systemRecords: lookup2 });

expect(result2.processorOnly === 1, "a processor-only entry is counted");
expect(result2.matched === 1, "the matching entry is still matched");
expect(result2.totalEntries === 2, "the total count includes processor-only");

/* ---- scenario 3: a system-only record ---- */

const lookup3 = new InMemorySystemRecordLookup();
lookup3.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
lookup3.add({ providerTransactionId: "txn-002", type: "payment", amountMinor: 3_000n });
const result3 = importProcessorReport(makeReport([
  { id: "txn-001", type: "payment", amount: 10_000n },
]), { systemRecords: lookup3 });

expect(result3.systemOnly === 1, "a system-only record is counted");
expect(result3.matched === 1, "the matching entry is still matched");
expect(result3.totalEntries === 2, "the total count includes system-only");

/* ---- scenario 4: an amount mismatch ---- */

const lookup4 = new InMemorySystemRecordLookup();
lookup4.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
const result4 = importProcessorReport(makeReport([
  { id: "txn-001", type: "payment", amount: 12_000n },
]), { systemRecords: lookup4 });

expect(result4.amountMismatches === 1, "an amount mismatch is counted");
expect(result4.matched === 0, "no match when amounts differ");

/* ---- scenario 5: mixed outcomes ---- */

const lookup5 = new InMemorySystemRecordLookup();
lookup5.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
lookup5.add({ providerTransactionId: "txn-002", type: "refund", amountMinor: 5_000n });
lookup5.add({ providerTransactionId: "txn-003", type: "payment", amountMinor: 8_000n });
const result5 = importProcessorReport(makeReport([
  { id: "txn-001", type: "payment", amount: 10_000n },
  { id: "txn-002", type: "refund", amount: 6_000n },
  { id: "txn-999", type: "payment", amount: 7_000n },
]), { systemRecords: lookup5 });

expect(result5.matched === 1, "one matched in the mixed case");
expect(result5.amountMismatches === 1, "one amount mismatch in the mixed case");
expect(result5.processorOnly === 1, "one processor-only in the mixed case");
expect(result5.systemOnly === 1, "one system-only in the mixed case");
expect(result5.totalEntries === 4, "the total count is correct in the mixed case");

/* ---- scenario 6: the match records carry the right metadata ---- */

if (result4.amountMismatches === 1) {
  const mismatch = result4.matches.find((match) => match.status === "amount_mismatch");
  expect(mismatch?.providerTransactionId === "txn-001", "the mismatch carries the right transaction id");
  expect(mismatch?.processorAmountMinor === 12_000n, "the mismatch carries the processor amount");
  expect(mismatch?.systemAmountMinor === 10_000n, "the mismatch carries the system amount");
}

/* ---- scenario 7: a processor-only match has null system amount ---- */

if (result2.processorOnly === 1) {
  const processorOnly = result2.matches.find((match) => match.status === "processor_only");
  expect(processorOnly?.systemAmountMinor === null, "a processor-only match has null system amount");
  expect(processorOnly?.processorAmountMinor === 7_000n, "a processor-only match carries the processor amount");
}

/* ---- scenario 8: a system-only match has zero processor amount ---- */

if (result3.systemOnly === 1) {
  const systemOnly = result3.matches.find((match) => match.status === "system_only");
  expect(systemOnly?.processorAmountMinor === 0n, "a system-only match has zero processor amount");
  expect(systemOnly?.systemAmountMinor === 3_000n, "a system-only match carries the system amount");
}

/* ---- scenario 9: an empty processor report finds all system records as system-only ---- */

const lookup9 = new InMemorySystemRecordLookup();
lookup9.add({ providerTransactionId: "txn-001", type: "payment", amountMinor: 10_000n });
lookup9.add({ providerTransactionId: "txn-002", type: "refund", amountMinor: 5_000n });
const result9 = importProcessorReport(makeReport([]), { systemRecords: lookup9 });

expect(result9.systemOnly === 2, "an empty report finds all system records as system-only");
expect(result9.matched === 0, "no matches in an empty report");
expect(result9.processorOnly === 0, "no processor-only in an empty report");

/* ---- scenario 10: an empty system and an empty report ---- */

const lookup10 = new InMemorySystemRecordLookup();
const result10 = importProcessorReport(makeReport([]), { systemRecords: lookup10 });
expect(result10.totalEntries === 0, "an empty report with an empty system has zero entries");

/* ---- scenario 11: the report id is carried ---- */

expect(result1.reportId === "report-1", "the import result carries the right report id");

/* ---- scenario 12: different entry types are handled ---- */

const lookup12 = new InMemorySystemRecordLookup();
lookup12.add({ providerTransactionId: "txn-cb", type: "chargeback", amountMinor: 15_000n });
lookup12.add({ providerTransactionId: "txn-payout", type: "payout", amountMinor: 20_000n });
lookup12.add({ providerTransactionId: "txn-fee", type: "fee", amountMinor: 500n });
const result12 = importProcessorReport(makeReport([
  { id: "txn-cb", type: "chargeback", amount: 15_000n },
  { id: "txn-payout", type: "payout", amount: 20_000n },
  { id: "txn-fee", type: "fee", amount: 500n },
]), { systemRecords: lookup12 });

expect(result12.matched === 3, "chargeback, payout and fee entries all match");
expect(result12.totalEntries === 3, "all three entry types are counted");

/* ---- scenario 13: the matches array is in the right order ---- */

if (result5.totalEntries === 4) {
  expect(result5.matches[0]?.status === "matched", "the first match is the matched entry");
  expect(result5.matches[1]?.status === "amount_mismatch", "the second match is the amount mismatch");
  expect(result5.matches[2]?.status === "processor_only", "the third match is the processor-only entry");
  expect(result5.matches[3]?.status === "system_only", "the fourth match is the system-only record");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments reconciliation import gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments reconciliation import gate passed: ${checks} checks, a service that matches processor report entries against system records and reports the four match outcomes - matched, processor_only, system_only, and amount_mismatch - with correct counts and match metadata for every entry type\n`,
);
