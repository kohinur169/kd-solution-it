// path: lib/payments/ledger-balance.ts

/**
 * The payment core's ledger balance integrity check: the job that reads every group the ledger holds
 * and proves each one balances, alerting the office on any mismatch.
 *
 * ## What the check is
 *
 * Section 11 of the feature list says "the system continuously checks that the ledger is balanced and
 * alerts the office on any mismatch." The posting service (STEP 132) refuses an unbalanced group before
 * it is written, and the database's deferred constraint trigger refuses it at commit. Those two guards
 * make an unbalanced group rare. They do not make it impossible: a direct database write that bypasses
 * the service, a migration that altered a trigger, or a bug in a later STEP could leave a group whose
 * debits and credits are not equal. This job is the safety net that catches what the guards prevent
 * from happening, and it is the one place that asks the question "does every group in the ledger
 * balance?" rather than "does this group balance?"
 *
 * The job reads every group the store holds, sums the debits and the credits of each, and reports the
 * result. A group whose debits and credits are equal is balanced; a group whose debits and credits are
 * not equal is unbalanced, and an alert is created for the office. The report is the proof: it names
 * every group, its company, its debits, its credits, and whether it balances.
 *
 * ## What the alert is
 *
 * An alert is not a failure. It is a notification that the safety net caught something the guards
 * should have prevented. The office reads the alert, finds the group, and resolves the mismatch within
 * the three-day window section 11 names. Every alert is audit logged, because every mismatch and every
 * resolution step is.
 *
 * ## What this file is not
 *
 * It is not the posting service. It does not write entries; it reads them. It is not the reversal
 * service. It does not create corrections; it reports what is there. It is not the reconciliation
 * (section 11's match against processor reports) - that is a later STEP. This file is the balance check
 * and the alert.
 */

import type { LedgerEntry, LedgerEntryStore } from "./ledger-posting.ts";

/** The balance of one ledger group: its debits, its credits, and whether they are equal. */
export interface LedgerGroupBalance {
  readonly entryGroupId: string;
  readonly companyId: string;
  readonly debits: bigint;
  readonly credits: bigint;
  readonly balanced: boolean;
  /** debits - credits. Zero when the group balances, non-zero when it does not. */
  readonly difference: bigint;
}

/** An alert for the office: a group that does not balance, with the numbers that prove it. */
export interface LedgerBalanceAlert {
  readonly entryGroupId: string;
  readonly companyId: string;
  readonly debits: bigint;
  readonly credits: bigint;
  readonly difference: bigint;
  readonly detectedAt: string;
}

/** The report of a balance check: every group, its balance, and the alerts the mismatches produced. */
export interface LedgerBalanceReport {
  readonly checkedAt: string;
  readonly totalGroups: number;
  readonly balancedGroups: number;
  readonly unbalancedGroups: number;
  readonly groups: readonly LedgerGroupBalance[];
  readonly alerts: readonly LedgerBalanceAlert[];
}

/** Read every group the store holds and report whether each one balances. */
export function checkLedgerBalance(store: LedgerEntryStore): LedgerBalanceReport {
  const groupIds = store.listGroupIds();
  const groups: LedgerGroupBalance[] = [];
  const alerts: LedgerBalanceAlert[] = [];
  const checkedAt = new Date().toISOString();

  for (const entryGroupId of groupIds) {
    const entries = store.findByGroup(entryGroupId);
    const debits = sumSide(entries, "debit");
    const credits = sumSide(entries, "credit");
    const difference = debits - credits;
    const balanced = difference === 0n;
    const companyId = entries[0]?.companyId ?? "unknown";

    groups.push({
      entryGroupId,
      companyId,
      debits,
      credits,
      balanced,
      difference,
    });

    if (!balanced) {
      alerts.push({
        entryGroupId,
        companyId,
        debits,
        credits,
        difference,
        detectedAt: checkedAt,
      });
    }
  }

  const balancedGroups = groups.filter((group) => group.balanced).length;

  return {
    checkedAt,
    totalGroups: groups.length,
    balancedGroups,
    unbalancedGroups: groups.length - balancedGroups,
    groups,
    alerts,
  };
}

/** Sum the amounts of every entry on one side of a group. */
function sumSide(entries: readonly LedgerEntry[], side: "debit" | "credit"): bigint {
  return entries
    .filter((entry) => entry.entrySide === side)
    .reduce((total, entry) => total + entry.amountMinor, 0n);
}
