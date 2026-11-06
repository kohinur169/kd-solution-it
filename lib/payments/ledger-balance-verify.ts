// path: lib/payments/ledger-balance-verify.ts
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  InMemoryLedgerEntryStore,
  postLedgerEntries,
  type LedgerEntry,
  type LedgerPostingGroup,
} from "./ledger-posting.ts";
import { reverseLedgerGroup } from "./ledger-reversal.ts";
import { checkLedgerBalance } from "./ledger-balance.ts";

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

/** Build a balanced payment group for balance tests. */
function makeGroup(): LedgerPostingGroup {
  return {
    companyId: "company-1",
    entryGroupId: randomUUID(),
    sourceType: "payment",
    sourceId: "source-1",
    paymentId: "payment-1",
    refundId: null,
    disputeId: null,
    description: null,
    postings: [
      { accountId: "account-debit", entrySide: "debit", amountMinor: 10000n },
      { accountId: "account-credit", entrySide: "credit", amountMinor: 10000n },
    ],
  };
}

/** Build an unbalanced entry pair and insert it directly into the store. */
function insertUnbalancedGroup(store: InMemoryLedgerEntryStore, groupId: string): void {
  const now = new Date().toISOString();
  const debit: LedgerEntry = {
    id: randomUUID(),
    companyId: "company-1",
    accountId: "account-debit",
    entryGroupId: groupId,
    entrySide: "debit",
    amountMinor: 10000n,
    currency: "USD",
    occurredAt: now,
    sourceType: "payment",
    sourceId: "source-1",
    paymentId: "payment-1",
    refundId: null,
    disputeId: null,
    description: null,
    reversalOfId: null,
    postedAt: now,
  };
  const credit: LedgerEntry = {
    id: randomUUID(),
    companyId: "company-1",
    accountId: "account-credit",
    entryGroupId: groupId,
    entrySide: "credit",
    amountMinor: 5000n,
    currency: "USD",
    occurredAt: now,
    sourceType: "payment",
    sourceId: "source-1",
    paymentId: "payment-1",
    refundId: null,
    disputeId: null,
    description: null,
    reversalOfId: null,
    postedAt: now,
  };
  store.insert(debit);
  store.insert(credit);
}

/* ---- scenario 1: a balanced group is reported as balanced ---- */

const store = new InMemoryLedgerEntryStore();
const group = makeGroup();
postLedgerEntries(group, { store });

const report = checkLedgerBalance(store);

expect(report.totalGroups === 1, "the report counts one group");
expect(report.balancedGroups === 1, "the report counts one balanced group");
expect(report.unbalancedGroups === 0, "the report counts no unbalanced groups");

const balancedGroup = report.groups[0];
expect(balancedGroup !== undefined && balancedGroup.balanced, "a balanced group is reported as balanced");
expect(balancedGroup?.difference === 0n, "a balanced group has a difference of zero");
expect(balancedGroup?.companyId === "company-1", "the report reads the company from the group");
expect(report.alerts.length === 0, "no alert is created for a balanced group");

/* ---- scenario 2: an unbalanced group is reported as unbalanced ---- */

const unbalancedStore = new InMemoryLedgerEntryStore();
const unbalancedGroupId = randomUUID();
insertUnbalancedGroup(unbalancedStore, unbalancedGroupId);

const unbalancedReport = checkLedgerBalance(unbalancedStore);

expect(unbalancedReport.totalGroups === 1, "the unbalanced report counts one group");
expect(unbalancedReport.unbalancedGroups === 1, "the unbalanced report counts one unbalanced group");
expect(unbalancedReport.balancedGroups === 0, "the unbalanced report counts no balanced groups");

const unbalancedGroup = unbalancedReport.groups[0];
expect(unbalancedGroup !== undefined && !unbalancedGroup.balanced, "an unbalanced group is reported as unbalanced");
expect(unbalancedGroup?.difference === 5000n, "the difference is debits minus credits");
expect(unbalancedGroup?.debits === 10000n, "the debits are read from the group");
expect(unbalancedGroup?.credits === 5000n, "the credits are read from the group");

/* ---- scenario 3: an alert is created for an unbalanced group ---- */

expect(unbalancedReport.alerts.length === 1, "an alert is created for an unbalanced group");

const alert = unbalancedReport.alerts[0];
expect(alert?.entryGroupId === unbalancedGroupId, "the alert names the unbalanced group");
expect(alert?.companyId === "company-1", "the alert names the company");
expect(alert?.detectedAt !== undefined, "the alert carries a detection time");

/* ---- scenario 4: a mixed store produces correct counts ---- */

const mixedStore = new InMemoryLedgerEntryStore();
postLedgerEntries(makeGroup(), { store: mixedStore });
postLedgerEntries(makeGroup(), { store: mixedStore });
insertUnbalancedGroup(mixedStore, randomUUID());

const mixedReport = checkLedgerBalance(mixedStore);

expect(mixedReport.totalGroups === 3, "the mixed report counts three groups");
expect(mixedReport.balancedGroups === 2, "the mixed report counts two balanced groups");
expect(mixedReport.unbalancedGroups === 1, "the mixed report counts one unbalanced group");
expect(mixedReport.alerts.length === 1, "the mixed report has one alert");
expect(
  mixedReport.totalGroups === mixedReport.balancedGroups + mixedReport.unbalancedGroups,
  "total groups equals balanced plus unbalanced",
);

/* ---- scenario 5: the report covers every group in the store ---- */

const storeGroupIds = mixedStore.listGroupIds();
const reportGroupIds = mixedReport.groups.map((g) => g.entryGroupId);
expect(
  storeGroupIds.every((id) => reportGroupIds.includes(id)),
  "every group in the store appears in the report",
);

/* ---- scenario 6: an empty store produces an empty report ---- */

const emptyStore = new InMemoryLedgerEntryStore();
const emptyReport = checkLedgerBalance(emptyStore);

expect(emptyReport.totalGroups === 0, "an empty store produces zero groups");
expect(emptyReport.balancedGroups === 0, "an empty store produces zero balanced groups");
expect(emptyReport.unbalancedGroups === 0, "an empty store produces zero unbalanced groups");
expect(emptyReport.alerts.length === 0, "an empty store produces zero alerts");

/* ---- scenario 7: a reversal group is also checked ---- */

const reversalStore = new InMemoryLedgerEntryStore();
const reversalGroup = makeGroup();
postLedgerEntries(reversalGroup, { store: reversalStore });
reverseLedgerGroup(reversalGroup.entryGroupId, { store: reversalStore });

const reversalReport = checkLedgerBalance(reversalStore);

expect(reversalReport.totalGroups === 2, "the reversal report counts two groups");
expect(reversalReport.balancedGroups === 2, "both the original and the reversal are balanced");
expect(reversalReport.unbalancedGroups === 0, "no unbalanced groups after a reversal");
expect(reversalReport.alerts.length === 0, "no alerts after a reversal");

/* ---- scenario 8: the checkedAt timestamp is set ---- */

expect(report.checkedAt !== undefined && report.checkedAt.length > 0, "the report carries a checked-at time");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments ledger balance gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments ledger balance gate passed: ${checks} checks, a balance check that reads every group the ledger holds and proves each one balances - a balanced group is reported as balanced, an unbalanced group is reported as unbalanced with its debits, credits and difference, an alert is created for the office, and the report covers every group in the store\n`,
);
