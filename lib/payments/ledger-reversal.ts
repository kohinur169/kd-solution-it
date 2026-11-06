// path: lib/payments/ledger-reversal.ts

/**
 * The payment core's ledger reversal service: the one place a correction is written, and the mirror
 * rule that makes it a correction rather than an edit.
 *
 * ## What reversal is
 *
 * Section 11 of the feature list says "ledger entries are never edited or deleted. Corrections are
 * written as reversing entries." This service is where that sentence becomes a check. A posted group
 * carries a set of debit and credit entries; this service reads them, mirrors each one with the
 * opposite side and the same amount, and writes the mirror as a new balanced group. The original entries
 * are never touched - the append-only guard of the database refuses every update and every removal, and
 * the service never tries. The correction is the mirror.
 *
 * The mirror is not a guess. Each reversal entry names the entry it undoes with `reversalOfId`, and the
 * reversal guard of the database checks that the side is the opposite, the amount is the same, the
 * currency and the merchant are the same, and the reversal is its own balanced group. This service
 * enforces the same rules before it writes, so a reversal that would violate the mirror is refused here
 * rather than at commit.
 *
 * ## The one-reversal rule
 *
 * An entry is reversed at most once. The unique index on `reversal_of_id` makes that a database fact;
 * this service checks it before it writes. A group whose entries have already been reversed is refused,
 * because a second reversal would fork the correction - the reader would not know which mirror is the
 * true one.
 *
 * ## What this file is not
 *
 * It is not the posting service. It writes reversal entries, not new movements. STEP 132 owns the
 * posting. It is also not the append-only guard: the database already refuses every update and every
 * removal of a ledger entry. This service simply never tries to update or remove - it writes new entries
 * and leaves the old ones alone.
 */

import { randomUUID } from "node:crypto";
import type { LedgerEntry, LedgerEntryStore } from "./ledger-posting.ts";

/** The result of reversing a group: the reversal entries that were written, or the reason it was refused. */
export type LedgerReversalResult =
  | { status: "reversed"; entries: readonly LedgerEntry[] }
  | { status: "rejected"; reason: string };

/** Reverse a posted group: read the originals, mirror them, write the mirror. */
export function reverseLedgerGroup(
  entryGroupId: string,
  options: { readonly store: LedgerEntryStore },
): LedgerReversalResult {
  // 1. Read the original entries. A group that does not exist has nothing to reverse.
  const originals = options.store.findByGroup(entryGroupId);
  const first = originals[0];

  if (first === undefined) {
    return { status: "rejected", reason: "no entries found for this group" };
  }

  // 2. Check that no entry in the group has already been reversed. An entry is reversed at most once.
  for (const original of originals) {
    if (options.store.findByReversalOf(original.id) !== null) {
      return {
        status: "rejected",
        reason: "an entry in this group has already been reversed",
      };
    }
  }

  // 3. Check that all originals belong to one company and one source. A reversal mirrors a group, not a
  //    collection of unrelated entries.
  if (!originals.every((entry) => entry.companyId === first.companyId)) {
    return { status: "rejected", reason: "the entries of this group belong to different companies" };
  }

  if (!originals.every((entry) => entry.sourceType === first.sourceType)) {
    return { status: "rejected", reason: "the entries of this group carry different source types" };
  }

  // 4. Build the reversal entries. Each mirrors its original: opposite side, same amount, same account,
  //    same currency, same company, same source. The reversal group is a new group id.
  const now = new Date().toISOString();
  const reversalGroupId = randomUUID();
  const entries: LedgerEntry[] = originals.map((original) => ({
    id: randomUUID(),
    companyId: original.companyId,
    accountId: original.accountId,
    entryGroupId: reversalGroupId,
    entrySide: original.entrySide === "debit" ? "credit" : "debit",
    amountMinor: original.amountMinor,
    currency: original.currency,
    occurredAt: now,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    paymentId: original.paymentId,
    refundId: original.refundId,
    disputeId: original.disputeId,
    description: original.description,
    reversalOfId: original.id,
    postedAt: now,
  }));

  // 5. Check the reversal group balances. It always does - a mirror of a balanced group is balanced -
  //    but the check is here so a future change to the mirror cannot silently break it.
  const reversalDebits = entries
    .filter((entry) => entry.entrySide === "debit")
    .reduce((total, entry) => total + entry.amountMinor, 0n);
  const reversalCredits = entries
    .filter((entry) => entry.entrySide === "credit")
    .reduce((total, entry) => total + entry.amountMinor, 0n);

  if (reversalDebits !== reversalCredits) {
    return {
      status: "rejected",
      reason: `a reversal group must balance: debits ${String(reversalDebits)} and credits ${String(reversalCredits)} are not equal`,
    };
  }

  // 6. Write the reversal entries. The originals are untouched.
  for (const entry of entries) {
    options.store.insert(entry);
  }

  return { status: "reversed", entries };
}
