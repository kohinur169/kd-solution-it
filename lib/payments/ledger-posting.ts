// path: lib/payments/ledger-posting.ts

/**
 * The payment core's ledger posting service: the one place a debit and a credit are written, and the
 * balance rule that makes the pair a pair.
 *
 * ## What posting is
 *
 * Section 11 of the feature list says "every money movement writes a debit entry and a credit entry and
 * the pair always balances to zero." This service is where that sentence becomes a check: a posting
 * group carries a set of entries - some debits, some credits - and the service sums them before it
 * writes anything. A group whose debits and credits are not equal is refused, and nothing is written.
 * The caller learns the reason and corrects the group.
 *
 * The ten movements of section 11 - payment received, platform fee, hold, reserve, settlement, payout,
 * refund, chargeback, chargeback fee and subscription charge - are the closed vocabulary of source
 * types. A posting names one, and the service checks the source pair the database enforces: a payment
 * source carries a payment id, a refund source carries a refund id, a chargeback source carries a
 * dispute id. An entry without its source is refused here, the same refusal the database would make
 * at insert.
 *
 * ## The balance rule
 *
 * The rule is not "the caller promises to balance." The service computes the sum of every debit and the
 * sum of every credit, and refuses the group unless they are equal. A group with credits but no debits
 * is refused. A group with debits but no credits is refused. A group whose debits and credits are both
 * zero is refused - a movement of zero is not a movement. The balance is proved before anything is
 * written, not discovered after.
 *
 * ## What this file is not
 *
 * It is not the reversal. It writes new entries; it does not reverse old ones. STEP 133 owns the
 * reversal. It is also not the account setup: the accounts this service posts to are opened by STEP 131.
 * It is not the API route or the UI. This file is the posting and the balance check.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../utils/freeze.ts";
import { CURRENCY_USD } from "./money.ts";
import type { LedgerAccountSide } from "./ledger-accounts.ts";

/** The ten closed source types of section 11. A movement of any other kind is a new migration. */
export type LedgerSourceType =
  | "payment"
  | "platform_fee"
  | "hold"
  | "reserve"
  | "settlement"
  | "payout"
  | "refund"
  | "chargeback"
  | "chargeback_fee"
  | "subscription_charge";

/** The closed list of source types, in the order section 11 names them. */
export const LEDGER_SOURCE_TYPES: readonly LedgerSourceType[] = deepFreeze([
  "payment",
  "platform_fee",
  "hold",
  "reserve",
  "settlement",
  "payout",
  "refund",
  "chargeback",
  "chargeback_fee",
  "subscription_charge",
]);

/** One side of a money movement: which account, which side, how much. */
export interface LedgerPosting {
  readonly accountId: string;
  readonly entrySide: LedgerAccountSide;
  readonly amountMinor: bigint;
}

/** A group of postings that must balance, with the source that caused the movement. */
export interface LedgerPostingGroup {
  readonly companyId: string;
  readonly entryGroupId: string;
  readonly sourceType: LedgerSourceType;
  readonly sourceId: string;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly disputeId: string | null;
  readonly description: string | null;
  readonly postings: readonly LedgerPosting[];
}

/** A ledger entry as the store holds it: the posting plus its identity and metadata. */
export interface LedgerEntry {
  readonly id: string;
  readonly companyId: string;
  readonly accountId: string;
  readonly entryGroupId: string;
  readonly entrySide: LedgerAccountSide;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
  readonly sourceType: LedgerSourceType;
  readonly sourceId: string;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly disputeId: string | null;
  readonly description: string | null;
  readonly reversalOfId: string | null;
  readonly postedAt: string;
}

/** What the service reads and writes: the ledger entries. The store is the caller's. */
export interface LedgerEntryStore {
  /** The entries a group already holds, or an empty list when the group is new. */
  findByGroup(entryGroupId: string): LedgerEntry[];
  /** The reversal that undoes this entry, or null when the entry is not reversed. */
  findByReversalOf(entryId: string): LedgerEntry | null;
  /** The ids of every group the store holds. */
  listGroupIds(): string[];
  /** Atomically insert a complete new group, or return false without writing any entries.
   * The store must serialize competing group IDs and reversal IDs. A database implementation must
   * perform these checks and the insert in one transaction, not as separate HTTP requests.
   */
  insertGroup(entries: readonly LedgerEntry[]): boolean;
}

/** The result of posting a group: the entries that were written, or the reason it was refused. */
export type LedgerPostingResult =
  | { status: "posted"; entries: readonly LedgerEntry[] }
  | { status: "rejected"; reason: string };

/** The in-memory store: a reference implementation that keys on entry id and group id. */
export class InMemoryLedgerEntryStore implements LedgerEntryStore {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly groups = new Map<string, string[]>();

  findByGroup(entryGroupId: string): LedgerEntry[] {
    const ids = this.groups.get(entryGroupId) ?? [];
    return ids
      .map((id) => this.entries.get(id))
      .filter((entry): entry is LedgerEntry => entry !== undefined);
  }

  findByReversalOf(entryId: string): LedgerEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.reversalOfId === entryId) {
        return entry;
      }
    }
    return null;
  }

  listGroupIds(): string[] {
    return [...this.groups.keys()];
  }

  insertGroup(entries: readonly LedgerEntry[]): boolean {
    // Materialize and freeze the complete batch before touching either index.
    const snapshots = entries.map((entry) => Object.freeze({ ...entry }));
    const first = snapshots[0];
    if (first === undefined || this.groups.has(first.entryGroupId)) return false;

    const ids = new Set<string>();
    const reversalIds = new Set<string>();
    let debits = 0n;
    let credits = 0n;
    for (const entry of snapshots) {
      if (entry.entryGroupId !== first.entryGroupId || entry.companyId !== first.companyId ||
          entry.currency !== first.currency || entry.amountMinor <= 0n || ids.has(entry.id) || this.entries.has(entry.id)) return false;
      if (entry.entrySide === "debit") debits += entry.amountMinor;
      else if (entry.entrySide === "credit") credits += entry.amountMinor;
      else return false;
      ids.add(entry.id);
      if (entry.reversalOfId !== null) {
        const original = this.entries.get(entry.reversalOfId);
        if (reversalIds.has(entry.reversalOfId) || this.findByReversalOf(entry.reversalOfId) !== null ||
            original === undefined || original.entryGroupId === entry.entryGroupId ||
            original.entrySide === entry.entrySide || original.accountId !== entry.accountId ||
            original.amountMinor !== entry.amountMinor || original.currency !== entry.currency ||
            original.companyId !== entry.companyId) return false;
        reversalIds.add(entry.reversalOfId);
      }
    }
    if (debits === 0n || debits !== credits) return false;

    // Validate the entire batch before mutating either index. The synchronous in-memory operation
    // cannot interleave with another insertion. This is not a database implementation.
    for (const entry of snapshots) this.entries.set(entry.id, entry);
    this.groups.set(first.entryGroupId, snapshots.map((entry) => entry.id));
    return true;
  }
}

/** Post a group: check the balance, check the source, then write. */
export function postLedgerEntries(
  group: LedgerPostingGroup,
  options: { readonly store: LedgerEntryStore },
): LedgerPostingResult {
  // A repeated group must never silently post twice. Persistent stores must also enforce this atomically.
  if (options.store.findByGroup(group.entryGroupId).length > 0) {
    return { status: "rejected", reason: "the ledger group already exists" };
  }
  if (group.postings.some((posting) => posting.entrySide !== "debit" && posting.entrySide !== "credit")) {
    return { status: "rejected", reason: "invalid ledger entry side" };
  }

  // 1. The balance. The sum of debits must equal the sum of credits, and both must be present.
  const debits = sumOf(group.postings, "debit");
  const credits = sumOf(group.postings, "credit");

  if (debits !== credits) {
    return {
      status: "rejected",
      reason: `a ledger group must balance: debits ${String(debits)} and credits ${String(credits)} are not equal`,
    };
  }

  if (debits === 0n) {
    return {
      status: "rejected",
      reason: "a ledger group must have at least one debit and one credit",
    };
  }

  // 2. The amounts. Every posting must be positive.
  if (group.postings.some((posting) => posting.amountMinor <= 0n)) {
    return { status: "rejected", reason: "a ledger entry amount must be positive" };
  }

  // 3. The source pair. A payment source carries a payment id, a refund a refund id, a chargeback a
  //    dispute id. The database enforces the same pairing at insert; this service refuses earlier.
  if (group.sourceType === "payment" && group.paymentId === null) {
    return { status: "rejected", reason: "a payment entry requires a payment id" };
  }

  if (group.sourceType === "refund" && group.refundId === null) {
    return { status: "rejected", reason: "a refund entry requires a refund id" };
  }

  if (
    (group.sourceType === "chargeback" || group.sourceType === "chargeback_fee") &&
    group.disputeId === null
  ) {
    return { status: "rejected", reason: `a ${group.sourceType} entry requires a dispute id` };
  }

  // 4. The description. Trimmed, 1 to 280 characters, or null.
  if (group.description !== null && group.description.trim() !== group.description) {
    return { status: "rejected", reason: "a ledger entry description must be trimmed" };
  }

  if (group.description !== null && (group.description.length < 1 || group.description.length > 280)) {
    return { status: "rejected", reason: "a ledger entry description must be between 1 and 280 characters" };
  }

  // 5. The entries. Build them, insert them, return them.
  const now = new Date().toISOString();
  const entries = group.postings.map((posting) => ({
    id: randomUUID(),
    companyId: group.companyId,
    accountId: posting.accountId,
    entryGroupId: group.entryGroupId,
    entrySide: posting.entrySide,
    amountMinor: posting.amountMinor,
    currency: CURRENCY_USD,
    occurredAt: now,
    sourceType: group.sourceType,
    sourceId: group.sourceId,
    paymentId: group.paymentId,
    refundId: group.refundId,
    disputeId: group.disputeId,
    description: group.description,
    reversalOfId: null,
    postedAt: now,
  }));

  if (!options.store.insertGroup(entries)) {
    return { status: "rejected", reason: "the ledger group or an entry already exists" };
  }

  return { status: "posted", entries };
}

/** Sum the amounts of every posting on one side. */
function sumOf(postings: readonly LedgerPosting[], side: LedgerAccountSide): bigint {
  return postings
    .filter((posting) => posting.entrySide === side)
    .reduce((total, posting) => total + posting.amountMinor, 0n);
}
