// path: lib/payments/negative-balance.ts

/**
 * The payment core's negative balance handling: the flow that covers a merchant's negative balance first
 * from the reserve, and any remaining amount through the contract collection process.
 *
 * ## What the negative balance is
 *
 * Section 10 of the feature list says "a negative balance is covered first from reserve. Any remaining
 * amount is collected through the contract process including legal collection." A merchant's balance is
 * the merchant's payable — what the platform owes the merchant. When a chargeback, a refund, or another
 * movement exceeds the merchant's available balance, the payable goes negative: the merchant owes the
 * platform money. The platform covers this negative balance in two steps.
 *
 * The first step is the reserve. The platform draws from the reserve_held account: the reserve is
 * debited, and the merchant's payable is credited by the same amount. The group balances. This brings the
 * merchant's payable back toward zero.
 *
 * The second step is the contract collection. If the reserve does not cover the full negative balance,
 * the remainder is recorded as a contract collection record. The record names the company, the
 * remaining amount, the source that caused the negative balance, and the time it was created. The
 * record is the basis for the legal collection process — it is what the office uses to pursue the
 * remaining amount.
 *
 * ## What this file is not
 *
 * It is not the reserve posting (STEP 137 owns that). It is not the chargeback or refund that caused
 * the negative balance (those are separate movements). It is not the legal collection itself — the
 * record is the basis for it, not the collection. It is not the API route or the UI. This file is the
 * handling: the reserve draw and the contract collection record.
 */

import { randomUUID } from "node:crypto";
import { postLedgerEntries, type LedgerEntryStore, type LedgerSourceType } from "./ledger-posting.ts";

/** A contract collection record: the remainder of a negative balance that the reserve did not cover. */
export interface ContractCollectionRecord {
  readonly id: string;
  readonly companyId: string;
  /** The amount the reserve did not cover, in minor units. */
  readonly amountMinor: bigint;
  /** How much the reserve covered, in minor units. */
  readonly reserveDrawnMinor: bigint;
  readonly sourceType: LedgerSourceType;
  readonly sourceId: string;
  readonly createdAtEpochMs: number;
  readonly status: "open" | "collected";
}

/** What the handling service reads and writes: the contract collection records. The store is the caller's. */
export interface ContractCollectionStore {
  /** Store a collection record. */
  insert(record: ContractCollectionRecord): void;
  /** The record an id already holds, or null when the record is new. */
  findById(id: string): ContractCollectionRecord | null;
  /** Every record a company has, open and collected. */
  findByCompany(companyId: string): ContractCollectionRecord[];
  /** Every open record a company has — the ones the office is still pursuing. */
  findOpenByCompany(companyId: string): ContractCollectionRecord[];
}

/** The in-memory store: a reference implementation that keys on record id. */
export class InMemoryContractCollectionStore implements ContractCollectionStore {
  private readonly records = new Map<string, ContractCollectionRecord>();

  insert(record: ContractCollectionRecord): void {
    this.records.set(record.id, record);
  }

  findById(id: string): ContractCollectionRecord | null {
    return this.records.get(id) ?? null;
  }

  findByCompany(companyId: string): ContractCollectionRecord[] {
    return [...this.records.values()].filter((record) => record.companyId === companyId);
  }

  findOpenByCompany(companyId: string): ContractCollectionRecord[] {
    return this.findByCompany(companyId).filter((record) => record.status === "open");
  }
}

/** The result of handling a negative balance. */
export type NegativeBalanceHandlingResult =
  | { status: "covered"; reserveDrawn: bigint; collection: null }
  | { status: "partially_covered"; reserveDrawn: bigint; collection: ContractCollectionRecord }
  | { status: "rejected"; reason: string };

/** Handle a negative balance: draw from reserve first, record the remainder as a contract collection. */
export function handleNegativeBalance(
  amountMinor: bigint,
  options: {
    readonly collectionStore: ContractCollectionStore;
    readonly ledgerStore: LedgerEntryStore;
    readonly companyId: string;
    readonly reserveAvailableMinor: bigint;
    readonly sourceType: LedgerSourceType;
    readonly sourceId: string;
    readonly paymentId: string | null;
    readonly refundId: string | null;
    readonly disputeId: string | null;
    readonly occurredAtEpochMs: number;
  },
): NegativeBalanceHandlingResult {
  if (amountMinor <= 0n) {
    return { status: "rejected", reason: "a negative balance amount must be positive" };
  }

  if (options.reserveAvailableMinor < 0n) {
    return { status: "rejected", reason: "the available reserve must not be negative" };
  }

  // 1. Draw from the reserve first. The reserve covers up to the available reserve.
  const reserveDrawn = amountMinor < options.reserveAvailableMinor ? amountMinor : options.reserveAvailableMinor;

  // 2. Post the reserve draw group: debit reserve_held, credit merchant_payable. The group balances.
  if (reserveDrawn > 0n) {
    postLedgerEntries(
      {
        companyId: options.companyId,
        entryGroupId: randomUUID(),
        sourceType: options.sourceType,
        sourceId: options.sourceId,
        paymentId: options.paymentId,
        refundId: options.refundId,
        disputeId: options.disputeId,
        description: null,
        postings: [
          { accountId: "reserve_held", entrySide: "debit", amountMinor: reserveDrawn },
          { accountId: "merchant_payable", entrySide: "credit", amountMinor: reserveDrawn },
        ],
      },
      { store: options.ledgerStore },
    );
  }

  // 3. If the reserve did not cover the full amount, create a contract collection record for the remainder.
  const remainder = amountMinor - reserveDrawn;

  if (remainder === 0n) {
    return { status: "covered", reserveDrawn, collection: null };
  }

  const collection: ContractCollectionRecord = {
    id: randomUUID(),
    companyId: options.companyId,
    amountMinor: remainder,
    reserveDrawnMinor: reserveDrawn,
    sourceType: options.sourceType,
    sourceId: options.sourceId,
    createdAtEpochMs: options.occurredAtEpochMs,
    status: "open",
  };

  options.collectionStore.insert(collection);

  return { status: "partially_covered", reserveDrawn, collection };
}
