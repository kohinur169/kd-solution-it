// path: lib/payments/ledger-posting-verify.ts
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  LEDGER_SOURCE_TYPES,
  InMemoryLedgerEntryStore,
  postLedgerEntries,
  type LedgerPostingGroup,
  type LedgerSourceType,
} from "./ledger-posting.ts";

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

/** Build a balanced group for any source type, with the right source-pair ids. */
function makeGroup(sourceType: LedgerSourceType): LedgerPostingGroup {
  return {
    companyId: "company-1",
    entryGroupId: randomUUID(),
    sourceType,
    sourceId: "source-1",
    paymentId: sourceType === "payment" ? "payment-1" : null,
    refundId: sourceType === "refund" ? "refund-1" : null,
    disputeId: sourceType === "chargeback" || sourceType === "chargeback_fee" ? "dispute-1" : null,
    description: null,
    postings: [
      { accountId: "account-debit", entrySide: "debit", amountMinor: 10000n },
      { accountId: "account-credit", entrySide: "credit", amountMinor: 10000n },
    ],
  };
}

/* ---- scenario 1: a balanced group is posted ---- */

const balancedStore = new InMemoryLedgerEntryStore();
const balancedGroup = makeGroup("payment");
const balancedResult = postLedgerEntries(balancedGroup, { store: balancedStore });

expect(balancedResult.status === "posted", "a balanced group posts");
expect(balancedResult.status === "posted" && balancedResult.entries.length === 2, "the posting produces two entries");
expect(balancedStore.findByGroup(balancedGroup.entryGroupId).length === 2, "the store holds both entries");

const balancedDebits = balancedResult.status === "posted"
  ? balancedResult.entries.filter((e) => e.entrySide === "debit").reduce((s, e) => s + e.amountMinor, 0n)
  : 0n;
const balancedCredits = balancedResult.status === "posted"
  ? balancedResult.entries.filter((e) => e.entrySide === "credit").reduce((s, e) => s + e.amountMinor, 0n)
  : 0n;
expect(balancedDebits === balancedCredits, "the debits and credits of the posted group are equal");

expect(
  balancedResult.status === "posted" && balancedResult.entries.every((e) => e.currency === "USD"),
  "every posted entry carries USD",
);

/* ---- scenario 2: an unbalanced group is refused ---- */

const unbalancedStore = new InMemoryLedgerEntryStore();
const unbalancedGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [
    { accountId: "account-debit", entrySide: "debit", amountMinor: 10000n },
    { accountId: "account-credit", entrySide: "credit", amountMinor: 5000n },
  ],
};
const unbalancedResult = postLedgerEntries(unbalancedGroup, { store: unbalancedStore });

expect(unbalancedResult.status === "rejected", "an unbalanced group is refused");
expect(unbalancedStore.findByGroup(unbalancedGroup.entryGroupId).length === 0, "nothing was posted for an unbalanced group");

/* ---- scenario 3: a group with only credits is refused ---- */

const creditsOnlyStore = new InMemoryLedgerEntryStore();
const creditsOnlyGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [{ accountId: "account-credit", entrySide: "credit", amountMinor: 10000n }],
};
const creditsOnlyResult = postLedgerEntries(creditsOnlyGroup, { store: creditsOnlyStore });

expect(creditsOnlyResult.status === "rejected", "a group with credits but no debits is refused");
expect(creditsOnlyStore.findByGroup(creditsOnlyGroup.entryGroupId).length === 0, "nothing was posted for a credits-only group");

/* ---- scenario 4: a group with only debits is refused ---- */

const debitsOnlyStore = new InMemoryLedgerEntryStore();
const debitsOnlyGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [{ accountId: "account-debit", entrySide: "debit", amountMinor: 10000n }],
};
const debitsOnlyResult = postLedgerEntries(debitsOnlyGroup, { store: debitsOnlyStore });

expect(debitsOnlyResult.status === "rejected", "a group with debits but no credits is refused");
expect(debitsOnlyStore.findByGroup(debitsOnlyGroup.entryGroupId).length === 0, "nothing was posted for a debits-only group");

/* ---- scenario 5: a group with zero total is refused ---- */

const zeroStore = new InMemoryLedgerEntryStore();
const zeroGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [
    { accountId: "account-debit", entrySide: "debit", amountMinor: 0n },
    { accountId: "account-credit", entrySide: "credit", amountMinor: 0n },
  ],
};
const zeroResult = postLedgerEntries(zeroGroup, { store: zeroStore });

expect(zeroResult.status === "rejected", "a group whose debits and credits are both zero is refused");
expect(zeroStore.findByGroup(zeroGroup.entryGroupId).length === 0, "nothing was posted for a zero group");

/* ---- scenario 6: all ten source types are accepted ---- */

for (const sourceType of LEDGER_SOURCE_TYPES) {
  const store = new InMemoryLedgerEntryStore();
  const group = makeGroup(sourceType);
  const result = postLedgerEntries(group, { store });
  expect(
    result.status === "posted",
    `a ${sourceType} group posts`,
  );
}

/* ---- scenario 7: the source-pair checks ---- */

const noPaymentStore = new InMemoryLedgerEntryStore();
const noPaymentGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  paymentId: null,
};
const noPaymentResult = postLedgerEntries(noPaymentGroup, { store: noPaymentStore });
expect(noPaymentResult.status === "rejected", "a payment source without a payment id is refused");

const noRefundStore = new InMemoryLedgerEntryStore();
const noRefundGroup: LedgerPostingGroup = {
  ...makeGroup("refund"),
  entryGroupId: randomUUID(),
  refundId: null,
};
const noRefundResult = postLedgerEntries(noRefundGroup, { store: noRefundStore });
expect(noRefundResult.status === "rejected", "a refund source without a refund id is refused");

const noDisputeStore = new InMemoryLedgerEntryStore();
const noDisputeGroup: LedgerPostingGroup = {
  ...makeGroup("chargeback"),
  entryGroupId: randomUUID(),
  disputeId: null,
};
const noDisputeResult = postLedgerEntries(noDisputeGroup, { store: noDisputeStore });
expect(noDisputeResult.status === "rejected", "a chargeback source without a dispute id is refused");

const noDisputeFeeStore = new InMemoryLedgerEntryStore();
const noDisputeFeeGroup: LedgerPostingGroup = {
  ...makeGroup("chargeback_fee"),
  entryGroupId: randomUUID(),
  disputeId: null,
};
const noDisputeFeeResult = postLedgerEntries(noDisputeFeeGroup, { store: noDisputeFeeStore });
expect(noDisputeFeeResult.status === "rejected", "a chargeback_fee source without a dispute id is refused");

/* ---- scenario 8: non-positive amounts are refused ---- */

const zeroAmountStore = new InMemoryLedgerEntryStore();
// The zero group is already covered in scenario 5; here we check a positive/zero pair.
const zeroAmountGroup2: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [
    { accountId: "account-debit", entrySide: "debit", amountMinor: 10000n },
    { accountId: "account-credit", entrySide: "credit", amountMinor: 0n },
  ],
};
const zeroAmountResult = postLedgerEntries(zeroAmountGroup2, { store: zeroAmountStore });
expect(zeroAmountResult.status === "rejected", "a posting with a zero amount is refused");

const negativeStore = new InMemoryLedgerEntryStore();
const negativeGroup: LedgerPostingGroup = {
  ...makeGroup("payment"),
  entryGroupId: randomUUID(),
  postings: [
    { accountId: "account-debit", entrySide: "debit", amountMinor: -5000n },
    { accountId: "account-credit", entrySide: "credit", amountMinor: 5000n },
  ],
};
const negativeResult = postLedgerEntries(negativeGroup, { store: negativeStore });
expect(negativeResult.status === "rejected", "a posting with a negative amount is refused");

/* ---- scenario 9: the group is scoped to one merchant ---- */

const scopedStore = new InMemoryLedgerEntryStore();
const scopedGroup = makeGroup("payment");
const scopedResult = postLedgerEntries(scopedGroup, { store: scopedStore });

expect(
  scopedResult.status === "posted" && scopedResult.entries.every((e) => e.companyId === "company-1"),
  "every entry is scoped to the same company",
);

expect(
  scopedResult.status === "posted" && scopedResult.entries.every((e) => e.entryGroupId === scopedGroup.entryGroupId),
  "every entry carries the same group id",
);

expect(
  scopedResult.status === "posted" && scopedResult.entries.every((e) => e.reversalOfId === null),
  "no entry is a reversal",
);

expect(
  scopedResult.status === "posted" && scopedResult.entries.every((e) => e.sourceType === "payment"),
  "every entry carries the source type of the group",
);

/* ---- scenario 10: the store holds exactly what was posted ---- */

const storeGroup = makeGroup("payment");
const storeResult = postLedgerEntries(storeGroup, { store: scopedStore });
const storedEntries = scopedStore.findByGroup(storeGroup.entryGroupId);

expect(storedEntries.length === (storeResult.status === "posted" ? 2 : 0), "the store holds exactly the entries that were posted");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments ledger posting gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments ledger posting gate passed: ${checks} checks, a posting service that writes a debit and a credit for every money movement and refuses a group that does not balance - a balanced group posts, an unbalanced group is refused, the ten source types of section 11 are covered, and no entry is posted without its source\n`,
);
