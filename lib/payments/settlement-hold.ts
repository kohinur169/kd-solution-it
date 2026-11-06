// path: lib/payments/settlement-hold.ts

/**
 * The payment core's settlement hold: the hold that keeps captured funds in the ledger for the
 * configured number of days, and the scheduled release that makes them available after the period.
 *
 * ## What the hold is
 *
 * Section 10 of the feature list says "settlement hold days are set by super_admin, globally and per
 * sub-merchant when needed" and "settlement is released automatically after the hold period." When a
 * payment is captured, the merchant's payable increases. But the platform does not release the funds
 * yet — it holds them for the configured number of days. The hold is a state: the captured amount is
 * tracked, and the release date is calculated from the hold period.
 *
 * The hold posts a balanced ledger group (source type `hold`): the merchant's payable is debited and
 * credited by the same amount. The group balances, and the net effect on the payable is zero — the
 * entry records the state change, not a balance change. The settlement release posts a second balanced
 * group (source type `settlement`) that mirrors the hold, recording the release.
 *
 * ## What the scheduled release is
 *
 * The release is a job: it reads every hold the store holds, finds the ones whose release date has
 * passed, and releases them. A hold that is released is not released again. The job is the safety net
 * that makes the release automatic — the office does not need to check every hold manually.
 *
 * ## What this file is not
 *
 * It is not the payment capture (STEP 132 owns that). It is not the payout (a later STEP owns moving
 * the released funds to the merchant's bank). It is not the API route or the UI. This file is the hold
 * calculation and the release job.
 */

import { randomUUID } from "node:crypto";
import { postLedgerEntries, type LedgerEntryStore } from "./ledger-posting.ts";

/** One day in milliseconds: 24 hours. */
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The default settlement hold period: 2 days. */
export const DEFAULT_SETTLEMENT_HOLD_DAYS = 2;

/** A settlement hold: the captured amount, the hold period, and the release date. */
export interface SettlementHold {
  readonly id: string;
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly holdDays: number;
  readonly capturedAtEpochMs: number;
  readonly releaseAtEpochMs: number;
  readonly status: "held" | "released";
}

/** What the hold service reads and writes: the hold records. The store is the caller's. */
export interface SettlementHoldStore {
  /** Store a hold record. */
  insert(hold: SettlementHold): void;
  /** The hold a company already holds, or null when the hold is new. */
  findById(holdId: string): SettlementHold | null;
  /** Every hold a company has placed, newest first. */
  findByCompany(companyId: string): SettlementHold[];
  /** Every hold whose release date has passed and whose status is still held. */
  findReleaseable(nowEpochMs: number): SettlementHold[];
}

/** The in-memory store: a reference implementation that keys on hold id. */
export class InMemorySettlementHoldStore implements SettlementHoldStore {
  private readonly holds = new Map<string, SettlementHold>();

  insert(hold: SettlementHold): void {
    this.holds.set(hold.id, hold);
  }

  findById(holdId: string): SettlementHold | null {
    return this.holds.get(holdId) ?? null;
  }

  findByCompany(companyId: string): SettlementHold[] {
    return [...this.holds.values()].filter((hold) => hold.companyId === companyId);
  }

  findReleaseable(nowEpochMs: number): SettlementHold[] {
    return [...this.holds.values()].filter(
      (hold) => hold.status === "held" && nowEpochMs >= hold.releaseAtEpochMs,
    );
  }
}

/** The result of creating a settlement hold. */
export type SettlementHoldCreationResult =
  | { status: "created"; hold: SettlementHold }
  | { status: "rejected"; reason: string };

/** Create a settlement hold: validate, calculate, post the hold group, store the hold. */
export function createSettlementHold(
  amountMinor: bigint,
  holdDays: number,
  options: {
    readonly holdStore: SettlementHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly companyId: string;
    readonly capturedAtEpochMs: number;
  },
): SettlementHoldCreationResult {
  if (amountMinor <= 0n) {
    return { status: "rejected", reason: "a settlement hold amount must be positive" };
  }

  if (!Number.isSafeInteger(holdDays) || holdDays < 0 || !Number.isSafeInteger(options.capturedAtEpochMs) || !Number.isSafeInteger(options.capturedAtEpochMs + holdDays * MILLISECONDS_PER_DAY)) {
    return { status: "rejected", reason: "invalid settlement hold period or capture time" };
  }

  const releaseAtEpochMs = options.capturedAtEpochMs + holdDays * MILLISECONDS_PER_DAY;

  const hold: SettlementHold = {
    id: randomUUID(),
    companyId: options.companyId,
    amountMinor,
    holdDays,
    capturedAtEpochMs: options.capturedAtEpochMs,
    releaseAtEpochMs,
    status: "held",
  };

  // Post the hold group: debit and credit merchant_payable by the hold amount. The group balances.
  const posting = postLedgerEntries(
    {
      companyId: options.companyId,
      entryGroupId: randomUUID(),
      sourceType: "hold",
      sourceId: hold.id,
      paymentId: null,
      refundId: null,
      disputeId: null,
      description: null,
      postings: [
        { accountId: "merchant_payable", entrySide: "debit", amountMinor },
        { accountId: "merchant_payable", entrySide: "credit", amountMinor },
      ],
    },
    { store: options.ledgerStore },
  );
  if (posting.status === "rejected") return posting;

  options.holdStore.insert(hold);

  return { status: "created", hold };
}

/** Release a single settlement hold. Returns the released hold, or null when the hold does not exist. */
export function releaseSettlementHold(
  holdId: string,
  options: {
    readonly holdStore: SettlementHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly nowEpochMs: number;
  },
): SettlementHold | null {
  const hold = options.holdStore.findById(holdId);

  if (hold === null) {
    return null;
  }

  if (hold.status === "released") {
    return hold;
  }

  if (!Number.isSafeInteger(options.nowEpochMs) || options.nowEpochMs < hold.releaseAtEpochMs) {
    return null;
  }

  const released: SettlementHold = {
    ...hold,
    status: "released",
  };

  // Post the settlement group: mirror the hold group. The group balances.
  const posting = postLedgerEntries(
    {
      companyId: hold.companyId,
      entryGroupId: randomUUID(),
      sourceType: "settlement",
      sourceId: hold.id,
      paymentId: null,
      refundId: null,
      disputeId: null,
      description: null,
      postings: [
        { accountId: "merchant_payable", entrySide: "debit", amountMinor: hold.amountMinor },
        { accountId: "merchant_payable", entrySide: "credit", amountMinor: hold.amountMinor },
      ],
    },
    { store: options.ledgerStore },
  );
  if (posting.status === "rejected") return null;

  options.holdStore.insert(released);

  return released;
}

/** Release every settlement hold whose release date has passed. This is the scheduled release job. */
export function releaseSettlementHolds(
  options: {
    readonly holdStore: SettlementHoldStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly nowEpochMs: number;
  },
): SettlementHold[] {
  const releaseable = options.holdStore.findReleaseable(options.nowEpochMs);
  const released: SettlementHold[] = [];

  for (const hold of releaseable) {
    const result = releaseSettlementHold(hold.id, {
      holdStore: options.holdStore,
      ledgerStore: options.ledgerStore,
      nowEpochMs: options.nowEpochMs,
    });

    if (result !== null) {
      released.push(result);
    }
  }

  return released;
}
