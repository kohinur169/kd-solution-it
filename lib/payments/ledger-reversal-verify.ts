// path: lib/payments/ledger-reversal-verify.ts
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  InMemoryLedgerEntryStore,
  postLedgerEntries,
  type LedgerEntry,
  type LedgerPostingGroup,
} from "./ledger-posting.ts";
import { reverseLedgerGroup } from "./ledger-reversal.ts";

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

/** Build a balanced payment group for reversal tests. */
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

/* ---- scenario 1: a posted group can be reversed ---- */

const store = new InMemoryLedgerEntryStore();
const group = makeGroup();
const posted = postLedgerEntries(group, { store });

expect(posted.status === "posted", "the original group posts");

const originals = posted.status === "posted" ? posted.entries : [];
expect(originals.length === 2, "the original group has two entries");

const reversal = reverseLedgerGroup(group.entryGroupId, { store });
expect(reversal.status === "reversed", "a posted group can be reversed");

const reversalEntries = reversal.status === "reversed" ? reversal.entries : [];
expect(reversalEntries.length === 2, "the reversal produces two entries");

/* ---- scenario 2: the reversal is a mirror ---- */

const reversalByOriginalId = new Map<string, LedgerEntry>();
for (const entry of reversalEntries) {
  if (entry.reversalOfId !== null) {
    reversalByOriginalId.set(entry.reversalOfId, entry);
  }
}

for (const original of originals) {
  const mirror = reversalByOriginalId.get(original.id);
  expect(mirror !== undefined, "a reversal entry names the original it undoes");

  if (mirror !== undefined) {
    expect(
      mirror.entrySide !== original.entrySide,
      "the reversal of an entry is the opposite side",
    );
    expect(
      mirror.amountMinor === original.amountMinor,
      "the reversal of an entry is the same amount",
    );
    expect(
      mirror.accountId === original.accountId,
      "the reversal of an entry posts to the same account",
    );
  }
}

/* ---- scenario 3: the reversal is its own balanced group ---- */

const reversalGroupId = reversalEntries[0]?.entryGroupId;
expect(
  reversalGroupId !== undefined && reversalGroupId !== group.entryGroupId,
  "the reversal is its own balanced group",
);

const reversalDebits = reversalEntries
  .filter((entry) => entry.entrySide === "debit")
  .reduce((total, entry) => total + entry.amountMinor, 0n);
const reversalCredits = reversalEntries
  .filter((entry) => entry.entrySide === "credit")
  .reduce((total, entry) => total + entry.amountMinor, 0n);
expect(reversalDebits === reversalCredits, "the reversal group balances");

expect(
  store.findByGroup(reversalGroupId ?? "").length === reversalEntries.length,
  "the reversal entries are in the store under the reversal group id",
);

/* ---- scenario 4: a group that does not exist cannot be reversed ---- */

const missingReversal = reverseLedgerGroup(randomUUID(), { store });
expect(missingReversal.status === "rejected", "a group that does not exist cannot be reversed");

/* ---- scenario 5: a group that is already reversed cannot be reversed again ---- */

const secondReversal = reverseLedgerGroup(group.entryGroupId, { store });
expect(secondReversal.status === "rejected", "a group that is already reversed cannot be reversed again");

/* ---- scenario 6: the original entries are untouched ---- */

const originalsAfter = store.findByGroup(group.entryGroupId);
expect(originalsAfter.length === 2, "the original entries are still in the store");
expect(
  originalsAfter.every((entry) => entry.reversalOfId === null),
  "the original entries still have no reversal",
);

const firstOriginalBefore = originals[0];
const firstOriginalAfter = originalsAfter[0];
expect(
  firstOriginalBefore !== undefined && firstOriginalAfter !== undefined &&
    firstOriginalAfter.entrySide === firstOriginalBefore.entrySide,
  "the original entry still has its original side",
);
expect(
  firstOriginalBefore !== undefined && firstOriginalAfter !== undefined &&
    firstOriginalAfter.amountMinor === firstOriginalBefore.amountMinor,
  "the original entry still has its original amount",
);

/* ---- scenario 7: the reversal stays in the same currency, company and source ---- */

expect(
  reversalEntries.every((entry) => entry.currency === originals[0]?.currency),
  "every reversal entry carries the same currency as the original",
);
expect(
  reversalEntries.every((entry) => entry.companyId === originals[0]?.companyId),
  "every reversal entry stays in the same merchant as the original",
);
expect(
  reversalEntries.every((entry) => entry.sourceType === originals[0]?.sourceType),
  "every reversal entry carries the same source type as the original",
);

/* ---- scenario 8: the reversal entries carry the same source ---- */

expect(
  reversalEntries.every((entry) => entry.sourceId === originals[0]?.sourceId),
  "every reversal entry carries the same source id as the original",
);
expect(
  reversalEntries.every((entry) => entry.paymentId === originals[0]?.paymentId),
  "every reversal entry carries the same payment id as the original",
);

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments ledger reversal gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments ledger reversal gate passed: ${checks} checks, a reversal service that mirrors a posted group with a new balanced group - each reversal entry is the opposite side and the same amount of the entry it undoes, the reversal is its own group, an entry is reversed at most once, and the original entries are never touched\n`,
);
