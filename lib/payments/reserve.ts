// path: lib/payments/reserve.ts

/**
 * The payment core's rolling reserve: the percentage the platform holds back from every transaction as
 * risk protection, and the scheduled release that returns it after the configured number of days.
 *
 * ## What the reserve is
 *
 * Section 10 of the feature list says "rolling reserve exists for risk and negative balance protection.
 * Reserve percent and release days are set by super_admin." When a payment is captured, the platform
 * holds back a percentage of the amount as a rolling reserve. The merchant's payable is debited by the
 * reserve amount, and the platform's reserve account is credited by the same amount. The group balances.
 * After the release period, the reserve is returned: the reserve account is debited and the merchant's
 * payable is credited by the same amount. The group balances.
 *
 * The reserve is "rolling" because it is continuously adjusted: new transactions add to the reserve, and
 * old reserves are released on schedule. The `ReserveHold` record tracks each individual hold — its
 * amount, its release date, and its status — so the release job can find the ones that are ready.
 *
 * ## How the reserve is calculated
 *
 * The reserve is calculated in whole minor units: `reserve = (amount * basisPoints) / 10000`. The rate
 * is in basis points (500 means 5%). The division is integer division, so the reserve is always a whole
 * number of minor units. A rate of 500 on an amount of 10000 produces a reserve of 500.
 *
 * ## What this file is not
 *
 * It is not the negative balance handling (STEP 138 owns that — "a negative balance is covered first
 * from reserve"). It is not the payout. It is not the API route or the UI. This file is the reserve
 * calculation, the posting, and the release.
 */

import { randomUUID } from "node:crypto";
import { BASIS_POINTS_PER_UNIT, MIN_FEE_BPS, MAX_FEE_BPS } from "./platform-fee.ts";
import { postLedgerEntries, type LedgerEntryStore } from "./ledger-posting.ts";

/** The default rolling reserve rate: 5% (500 basis points). */
export const DEFAULT_RESERVE_BPS = 500;

/** The default rolling reserve release period: 30 days. */
export const DEFAULT_RESERVE_DAYS = 30;

/** One day in milliseconds: 24 hours. */
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** A rolling reserve hold: the held amount, the release date, and the status. */
export interface ReserveHold {
  readonly id: string;
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly reserveDays: number;
  readonly capturedAtEpochMs: number;
  readonly releaseAtEpochMs: number;
  readonly status: "held" | "released";
}

/** What the reserve service reads and writes: the hold records. The store is the caller's. */
export interface ReserveHoldStore {
  /** Store a hold record. */
  insert(hold: ReserveHold): void;
  /** The hold an id already holds, or null when the hold is new. */
  findById(holdId: string): ReserveHold | null;
  /** Every hold a company has placed. */
  findByCompany(companyId: string): ReserveHold[];
  /** Every hold whose release date has passed and whose status is still held. */
  findReleaseable(nowEpochMs: number): ReserveHold[];
}

/** The in-memory store: a reference implementation that keys on hold id. */
export class InMemoryReserveHoldStore implements ReserveHoldStore {
  private readonly holds = new Map<string, ReserveHold>();

  insert(hold: ReserveHold): void {
    this.holds.set(hold.id, hold);
  }

  findById(holdId: string): ReserveHold | null {
    return this.holds.get(holdId) ?? null;
  }

  findByCompany(companyId: string): ReserveHold[] {
    return [...this.holds.values()].filter((hold) => hold.companyId === companyId);
  }

  findReleaseable(nowEpochMs: number): ReserveHold[] {
    return [...this.holds.values()].filter(
      (hold) => hold.status === "held" && nowEpochMs >= hold.releaseAtEpochMs,
    );
  }
}

/** The result of posting a reserve hold. */
export type ReserveHoldCreationResult =
  | { status: "created"; hold: ReserveHold }
  | { status: "rejected"; reason: string };

/** Calculate the rolling reserve in minor units from an amount and a rate in basis points. */
export function calculateReserve(amountMinor: bigint, basisPoints: number): bigint {
  return (amountMinor * BigInt(basisPoints)) / BigInt(BASIS_POINTS_PER_UNIT);
}

/** Post a rolling reserve hold: validate, calculate, post the reserve group, store the hold. */
export function postReserve(
  amountMinor: bigint,
  basisPoints: number,
  reserveDays: number,
  options: {
    readonly holdStore: ReserveHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly companyId: string;
    readonly capturedAtEpochMs: number;
  },
): ReserveHoldCreationResult {
  if (amountMinor <= 0n) {
    return { status: "rejected", reason: "a reserve amount must be positive" };
  }

  if (basisPoints < MIN_FEE_BPS || basisPoints > MAX_FEE_BPS) {
    return {
      status: "rejected",
      reason: `the reserve rate must be between ${MIN_FEE_BPS} and ${MAX_FEE_BPS} basis points`,
    };
  }

  if (reserveDays < 0) {
    return { status: "rejected", reason: "a reserve release period must not be negative" };
  }

  const reserve = calculateReserve(amountMinor, basisPoints);

  if (reserve === 0n) {
    return { status: "rejected", reason: "the reserve is zero, nothing to post" };
  }

  const releaseAtEpochMs = options.capturedAtEpochMs + reserveDays * MILLISECONDS_PER_DAY;

  const hold: ReserveHold = {
    id: randomUUID(),
    companyId: options.companyId,
    amountMinor: reserve,
    reserveDays,
    capturedAtEpochMs: options.capturedAtEpochMs,
    releaseAtEpochMs,
    status: "held",
  };

  // Post the reserve group: debit merchant_payable, credit reserve_held. The group balances.
  postLedgerEntries(
    {
      companyId: options.companyId,
      entryGroupId: randomUUID(),
      sourceType: "reserve",
      sourceId: hold.id,
      paymentId: null,
      refundId: null,
      disputeId: null,
      description: null,
      postings: [
        { accountId: "merchant_payable", entrySide: "debit", amountMinor: reserve },
        { accountId: "reserve_held", entrySide: "credit", amountMinor: reserve },
      ],
    },
    { store: options.ledgerStore },
  );

  options.holdStore.insert(hold);

  return { status: "created", hold };
}

/** Release a single reserve hold. Returns the released hold, or null when the hold does not exist. */
export function releaseReserve(
  holdId: string,
  options: {
    readonly holdStore: ReserveHoldStore;
    readonly ledgerStore: LedgerEntryStore;
  },
): ReserveHold | null {
  const hold = options.holdStore.findById(holdId);

  if (hold === null) {
    return null;
  }

  if (hold.status === "released") {
    return hold;
  }

  const released: ReserveHold = {
    ...hold,
    status: "released",
  };

  // Post the release group: debit reserve_held, credit merchant_payable. The group balances.
  postLedgerEntries(
    {
      companyId: hold.companyId,
      entryGroupId: randomUUID(),
      sourceType: "reserve",
      sourceId: hold.id,
      paymentId: null,
      refundId: null,
      disputeId: null,
      description: null,
      postings: [
        { accountId: "reserve_held", entrySide: "debit", amountMinor: hold.amountMinor },
        { accountId: "merchant_payable", entrySide: "credit", amountMinor: hold.amountMinor },
      ],
    },
    { store: options.ledgerStore },
  );

  options.holdStore.insert(released);

  return released;
}

/** Release every reserve hold whose release date has passed. This is the scheduled release job. */
export function releaseReserves(
  options: {
    readonly holdStore: ReserveHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly nowEpochMs: number;
  },
): ReserveHold[] {
  const releaseable = options.holdStore.findReleaseable(options.nowEpochMs);
  const released: ReserveHold[] = [];

  for (const hold of releaseable) {
    const result = releaseReserve(hold.id, {
      holdStore: options.holdStore,
      ledgerStore: options.ledgerStore,
    });

    if (result !== null) {
      released.push(result);
    }
  }

  return released;
}
