// path: lib/payments/reconciliation-import.ts

/**
 * The payment core's reconciliation import: the service that matches processor report entries against
 * system records and reports the four match outcomes.
 *
 * ## What reconciliation is
 *
 * Section 11 says "reconciliation matches system records with processor reports. A mismatch must be
 * resolved by the responsible team within 3 days." A processor report is a list of transactions the
 * provider says happened — payments, refunds, chargebacks, payouts. The system has its own records of
 * those same transactions. Reconciliation compares the two sides and finds the differences.
 *
 * There are five outcomes:
 *
 * - **matched**: the system and the processor both have the transaction with the same amount.
 * - **processor_only**: the processor reports a transaction the system does not have. The system is
 *   missing a record — this is a system-side gap.
 * - **system_only**: the system has a transaction the processor does not report. The processor is
 *   missing a record — this is a processor-side gap.
 * - **type_mismatch**: both sides use the same ID for different transaction types.
 * - **amount_mismatch**: both sides have the transaction but the amounts differ. Something is wrong
 *   with one of the records.
 *
 * ## What this file is not
 *
 * It is not the mismatch resolution queue (STEP 146 owns that — this file produces the mismatches,
 * STEP 146 queues and tracks them). It is not the processor adapter that fetches the report (STEPs
 * 147-169 own those). It is not the audit log (a later STEP owns that). This file is the core matching
 * engine: the report, the system record lookup, the match, and the import result.
 */

/** The types of transactions a processor report can contain. */
export type ReconciliationEntryType = "payment" | "refund" | "chargeback" | "payout" | "fee";

/** One entry in a processor report: what the provider says happened. */
export interface ProcessorReportEntry {
  readonly providerTransactionId: string;
  readonly type: ReconciliationEntryType;
  readonly amountMinor: bigint;
}

/** A processor report: a set of entries for a provider and a period. */
export interface ProcessorReport {
  readonly id: string;
  readonly providerName: string;
  readonly periodStartEpochMs: number;
  readonly periodEndEpochMs: number;
  readonly entries: ProcessorReportEntry[];
}

/** A system record: what the platform's own ledger says happened. */
export interface SystemRecord {
  readonly providerTransactionId: string;
  readonly type: ReconciliationEntryType;
  readonly amountMinor: bigint;
}

/** The system record lookup: the seam the caller implements. The core reads system records through it. */
export interface SystemRecordLookup {
  /** The system record a provider transaction id holds, or null when the system does not have it. */
  findByProviderTransactionId(providerTransactionId: string): SystemRecord | null;
  /** Every system record in the given period. */
  listByPeriod(periodStartEpochMs: number, periodEndEpochMs: number): SystemRecord[];
}

/** The four match outcomes. */
export type ReconciliationMatchStatus = "matched" | "system_only" | "processor_only" | "amount_mismatch" | "type_mismatch";

/** A single match result: one comparison between a processor entry and a system record. */
export interface ReconciliationMatch {
  readonly providerTransactionId: string;
  readonly type: ReconciliationEntryType;
  readonly processorAmountMinor: bigint;
  readonly systemAmountMinor: bigint | null;
  readonly status: ReconciliationMatchStatus;
}

/** The result of importing a processor report. */
export interface ReconciliationImportResult {
  readonly reportId: string;
  readonly totalEntries: number;
  readonly matched: number;
  readonly systemOnly: number;
  readonly processorOnly: number;
  readonly amountMismatches: number;
  readonly typeMismatches: number;
  readonly matches: ReconciliationMatch[];
}

/** Import a processor report: match every entry against the system and report the four outcomes. */
export function importProcessorReport(
  report: ProcessorReport,
  options: {
    readonly systemRecords: SystemRecordLookup;
  },
): ReconciliationImportResult {
  // 1. Validate the report.
  if (report.providerName.trim().length === 0) {
    throw new Error("the processor report must have a provider name");
  }
  if (report.periodStartEpochMs >= report.periodEndEpochMs) {
    throw new Error("the processor report period must have a start before the end");
  }
  const seenIds = new Set<string>();
  for (const entry of report.entries) {
    if (seenIds.has(entry.providerTransactionId)) throw new Error("duplicate processor transaction id");
    seenIds.add(entry.providerTransactionId);
    if (entry.providerTransactionId.trim().length === 0) {
      throw new Error("a processor report entry must have a provider transaction id");
    }
  }

  const matches: ReconciliationMatch[] = [];

  // 2. For each processor report entry, look up the system record and compare.
  for (const entry of report.entries) {
    const systemRecord = options.systemRecords.findByProviderTransactionId(entry.providerTransactionId);

    if (systemRecord === null) {
      matches.push({
        providerTransactionId: entry.providerTransactionId,
        type: entry.type,
        processorAmountMinor: entry.amountMinor,
        systemAmountMinor: null,
        status: "processor_only",
      });
    } else if (systemRecord.type !== entry.type) {
      matches.push({
        providerTransactionId: entry.providerTransactionId, type: entry.type,
        processorAmountMinor: entry.amountMinor, systemAmountMinor: systemRecord.amountMinor, status: "type_mismatch",
      });
    } else if (systemRecord.amountMinor === entry.amountMinor) {
      matches.push({
        providerTransactionId: entry.providerTransactionId,
        type: entry.type,
        processorAmountMinor: entry.amountMinor,
        systemAmountMinor: systemRecord.amountMinor,
        status: "matched",
      });
    } else {
      matches.push({
        providerTransactionId: entry.providerTransactionId,
        type: entry.type,
        processorAmountMinor: entry.amountMinor,
        systemAmountMinor: systemRecord.amountMinor,
        status: "amount_mismatch",
      });
    }
  }

  // 3. Find system-only records: system records not in the processor report.
  const processorIds = new Set(report.entries.map((entry) => entry.providerTransactionId));
  const systemRecords = options.systemRecords.listByPeriod(report.periodStartEpochMs, report.periodEndEpochMs);

  for (const systemRecord of systemRecords) {
    if (!processorIds.has(systemRecord.providerTransactionId)) {
      matches.push({
        providerTransactionId: systemRecord.providerTransactionId,
        type: systemRecord.type,
        processorAmountMinor: 0n,
        systemAmountMinor: systemRecord.amountMinor,
        status: "system_only",
      });
    }
  }

  // 4. Count the matches by status.
  let matched = 0;
  let systemOnly = 0;
  let processorOnly = 0;
  let amountMismatches = 0;
  let typeMismatches = 0;

  for (const match of matches) {
    switch (match.status) {
      case "matched": matched++; break;
      case "system_only": systemOnly++; break;
      case "processor_only": processorOnly++; break;
      case "amount_mismatch": amountMismatches++; break;
      case "type_mismatch": typeMismatches++; break;
    }
  }

  return {
    reportId: report.id,
    totalEntries: matches.length,
    matched,
    systemOnly,
    processorOnly,
    amountMismatches,
    typeMismatches,
    matches,
  };
}
