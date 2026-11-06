// path: lib/payments/settlement-release.ts

/**
 * The payment core's settlement release background job: the service that releases due settlement holds
 * after their hold period ends and records what it released.
 *
 * ## What the job is
 *
 * Section 10 says "settlement is released automatically after the hold period" and section 27 lists
 * "settlement release after hold days" as a background job. A settlement hold (STEP 136) is a period
 * during which a captured payment's funds are kept in a hold account. When the hold period ends, the
 * funds are released: the hold account is debited and the merchant's payable is credited. The release
 * is automatic — a background job runs periodically, finds every hold whose release time has come, and
 * releases it.
 *
 * The job is idempotent. A hold that is already released is not released again. The `releaseSettlementHolds`
 * function (STEP 136) finds only holds in the "held" state whose release time has come, so a second job
 * run after the first finds nothing to release. The job can run at any interval without double-releasing.
 *
 * ## What this file is not
 *
 * It is not the settlement hold calculation (STEP 136 owns that — this file calls its release function).
 * It is not the payout execution (STEP 143 owns that). It is not the API route or the cron schedule
 * that triggers the job. This file is the core service: the job function, the release records it
 * creates, and the store for those records.
 */

import { randomUUID } from "node:crypto";
import {
  releaseSettlementHolds,
  type SettlementHold,
  type SettlementHoldStore,
} from "./settlement-hold.ts";
import type { LedgerEntryStore } from "./ledger-posting.ts";

/** A settlement release record: the record of one hold being released by the job. */
export interface SettlementReleaseRecord {
  readonly id: string;
  readonly companyId: string;
  readonly holdId: string;
  readonly amountMinor: bigint;
  readonly releasedAtEpochMs: number;
}

/** What the store reads and writes: the settlement release records. The store is the caller's. */
export interface SettlementReleaseStore {
  /** Store a release record, replacing any record with the same id. */
  insert(record: SettlementReleaseRecord): void;
  /** The record an id already holds, or null when the record is new. */
  findById(id: string): SettlementReleaseRecord | null;
  /** Every record a company has. */
  findByCompany(companyId: string): SettlementReleaseRecord[];
  /** The record a hold id has, or null when the hold was never released by this job. */
  findByHoldId(holdId: string): SettlementReleaseRecord | null;
}

/** The in-memory store: a reference implementation that keys on record id. */
export class InMemorySettlementReleaseStore implements SettlementReleaseStore {
  private readonly records = new Map<string, SettlementReleaseRecord>();

  insert(record: SettlementReleaseRecord): void {
    this.records.set(record.id, record);
  }

  findById(id: string): SettlementReleaseRecord | null {
    return this.records.get(id) ?? null;
  }

  findByCompany(companyId: string): SettlementReleaseRecord[] {
    return [...this.records.values()].filter((record) => record.companyId === companyId);
  }

  findByHoldId(holdId: string): SettlementReleaseRecord | null {
    return [...this.records.values()].find((record) => record.holdId === holdId) ?? null;
  }
}

/** The result of running the settlement release job. */
export type RunSettlementReleaseResult =
  | { status: "completed"; releasedCount: number; records: SettlementReleaseRecord[] }
  | { status: "failed"; reason: string };

/** Run the settlement release job: release all due holds and record what was released. */
export function runSettlementReleaseJob(
  options: {
    readonly store: SettlementReleaseStore;
    readonly holdStore: SettlementHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly nowEpochMs: number;
  },
): RunSettlementReleaseResult {
  // 1. Release all due holds. STEP 136's function finds "held" holds whose release time has come,
  //    posts the release ledger entries, and marks them "released".
  const releasedHolds: SettlementHold[] = releaseSettlementHolds({
    holdStore: options.holdStore,
    ledgerStore: options.ledgerStore,
    nowEpochMs: options.nowEpochMs,
  });

  // 2. Create a release record for each released hold.
  const records: SettlementReleaseRecord[] = [];
  for (const hold of releasedHolds) {
    const record: SettlementReleaseRecord = {
      id: randomUUID(),
      companyId: hold.companyId,
      holdId: hold.id,
      amountMinor: hold.amountMinor,
      releasedAtEpochMs: options.nowEpochMs,
    };
    options.store.insert(record);
    records.push(record);
  }

  return { status: "completed", releasedCount: records.length, records };
}
