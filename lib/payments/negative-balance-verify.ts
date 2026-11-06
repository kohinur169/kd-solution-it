// path: lib/payments/negative-balance-verify.ts
import process from "node:process";
import { InMemoryLedgerEntryStore } from "./ledger-posting.ts";
import {
  InMemoryContractCollectionStore,
  handleNegativeBalance,
} from "./negative-balance.ts";

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

const occurredAt = 1_000_000_000_000;

function makeOptions(collectionStore: InMemoryContractCollectionStore, ledgerStore: InMemoryLedgerEntryStore) {
  return {
    collectionStore,
    ledgerStore,
    companyId: "company-1",
    reserveAvailableMinor: 5_000n,
    sourceType: "chargeback" as const,
    sourceId: "dispute-1",
    paymentId: null,
    refundId: null,
    disputeId: "dispute-1",
    occurredAtEpochMs: occurredAt,
  };
}

/* ---- scenario 1: a negative balance covered entirely from reserve ---- */

const store1 = new InMemoryContractCollectionStore();
const ledger1 = new InMemoryLedgerEntryStore();
const covered = handleNegativeBalance(3_000n, makeOptions(store1, ledger1));

expect(covered.status === "covered", "a negative balance within the reserve is covered");
if (covered.status === "covered") {
  expect(covered.reserveDrawn === 3_000n, "the reserve drawn equals the negative balance");
  expect(covered.collection === null, "no contract collection record is created");
}

/* ---- scenario 2: a negative balance partially covered ---- */

const store2 = new InMemoryContractCollectionStore();
const ledger2 = new InMemoryLedgerEntryStore();
const partial = handleNegativeBalance(8_000n, makeOptions(store2, ledger2));

expect(partial.status === "partially_covered", "a negative balance exceeding the reserve is partially covered");
if (partial.status === "partially_covered") {
  expect(partial.reserveDrawn === 5_000n, "the reserve drawn equals the available reserve");
  expect(partial.collection !== null, "a contract collection record is created");
  expect(partial.collection.amountMinor === 3_000n, "the collection record carries the remainder");
  expect(store2.findById(partial.collection.id) !== null, "the collection record is stored");
  expect(partial.collection.status === "open", "the collection record starts in the open state");
}

/* ---- scenario 3: a negative balance with no reserve ---- */

const store3 = new InMemoryContractCollectionStore();
const ledger3 = new InMemoryLedgerEntryStore();
const noReserve = handleNegativeBalance(7_000n, {
  ...makeOptions(store3, ledger3),
  reserveAvailableMinor: 0n,
});

expect(noReserve.status === "partially_covered", "a negative balance with no reserve is fully collected");
if (noReserve.status === "partially_covered") {
  expect(noReserve.reserveDrawn === 0n, "no reserve is drawn");
  expect(noReserve.collection.amountMinor === 7_000n, "the collection record carries the full amount");
}

/* ---- scenario 4: a zero amount is rejected ---- */

const store4 = new InMemoryContractCollectionStore();
const ledger4 = new InMemoryLedgerEntryStore();
const zero = handleNegativeBalance(0n, makeOptions(store4, ledger4));
expect(zero.status === "rejected", "a zero negative balance is rejected");

/* ---- scenario 5: a negative amount is rejected ---- */

const store5 = new InMemoryContractCollectionStore();
const ledger5 = new InMemoryLedgerEntryStore();
const negative = handleNegativeBalance(-500n, makeOptions(store5, ledger5));
expect(negative.status === "rejected", "a negative negative balance is rejected");

/* ---- scenario 6: the reserve draw posts a balanced group ---- */

expect(ledger2.listGroupIds().length >= 1, "the reserve draw posts a ledger group");

let reserveGroupBalanced = false;
for (const groupId of ledger2.listGroupIds()) {
  const entries = ledger2.findByGroup(groupId);
  const debits = entries.filter((entry) => entry.entrySide === "debit").reduce((total, entry) => total + entry.amountMinor, 0n);
  const credits = entries.filter((entry) => entry.entrySide === "credit").reduce((total, entry) => total + entry.amountMinor, 0n);
  const debitAccounts = entries.filter((entry) => entry.entrySide === "debit").map((entry) => entry.accountId);
  const creditAccounts = entries.filter((entry) => entry.entrySide === "credit").map((entry) => entry.accountId);
  if (
    debits === credits &&
    debits === 5_000n &&
    debitAccounts[0] === "reserve_held" &&
    creditAccounts[0] === "merchant_payable"
  ) {
    reserveGroupBalanced = true;
  }
}
expect(reserveGroupBalanced, "the reserve draw group balances with debit to reserve_held and credit to merchant_payable");

/* ---- scenario 7: the reserve draw group carries the right source type ---- */

let reserveGroupSourceType = false;
for (const groupId of ledger2.listGroupIds()) {
  const entries = ledger2.findByGroup(groupId);
  if (entries.every((entry) => entry.sourceType === "chargeback")) {
    reserveGroupSourceType = true;
  }
}
expect(reserveGroupSourceType, "the reserve draw group carries the chargeback source type");

/* ---- scenario 8: the total covered equals the negative balance ---- */

if (partial.status === "partially_covered") {
  expect(
    partial.reserveDrawn + partial.collection.amountMinor === 8_000n,
    "the reserve drawn plus the collection amount equals the negative balance",
  );
}

/* ---- scenario 9: multiple contract collection records ---- */

const store9 = new InMemoryContractCollectionStore();
const ledger9 = new InMemoryLedgerEntryStore();
handleNegativeBalance(10_000n, { ...makeOptions(store9, ledger9), reserveAvailableMinor: 2_000n });
handleNegativeBalance(15_000n, { ...makeOptions(store9, ledger9), reserveAvailableMinor: 3_000n });
expect(store9.findByCompany("company-1").length === 2, "two collection records are stored for the same company");
expect(store9.findOpenByCompany("company-1").length === 2, "both records are open");

/* ---- scenario 10: the collection record carries the right metadata ---- */

if (partial.status === "partially_covered") {
  expect(partial.collection.companyId === "company-1", "the collection record carries the right company");
  expect(partial.collection.sourceType === "chargeback", "the collection record carries the right source type");
  expect(partial.collection.sourceId === "dispute-1", "the collection record carries the right source id");
  expect(partial.collection.reserveDrawnMinor === 5_000n, "the collection record carries how much the reserve drew");
}

/* ---- scenario 11: two collection records have different ids ---- */

const store11 = new InMemoryContractCollectionStore();
const ledger11 = new InMemoryLedgerEntryStore();
const r1 = handleNegativeBalance(10_000n, { ...makeOptions(store11, ledger11), reserveAvailableMinor: 0n });
const r2 = handleNegativeBalance(10_000n, { ...makeOptions(store11, ledger11), reserveAvailableMinor: 0n });
if (r1.status === "partially_covered" && r2.status === "partially_covered") {
  expect(r1.collection.id !== r2.collection.id, "two collection records have different ids");
}

/* ---- scenario 12: a covered result posts no collection record ---- */

expect(store1.findByCompany("company-1").length === 0, "a covered result posts no collection record");

/* ---- scenario 13: the reserve draw is limited to the available reserve ---- */

const store13 = new InMemoryContractCollectionStore();
const ledger13 = new InMemoryLedgerEntryStore();
const limited = handleNegativeBalance(20_000n, { ...makeOptions(store13, ledger13), reserveAvailableMinor: 3_000n });
if (limited.status === "partially_covered") {
  expect(limited.reserveDrawn === 3_000n, "the reserve drawn is limited to the available reserve");
  expect(limited.collection.amountMinor === 17_000n, "the collection amount is the difference");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments negative balance gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments negative balance gate passed: ${checks} checks, a handling service that covers a merchant's negative balance first from the reserve and records any remainder as a contract collection record - the reserve draw posts a balanced group (debit reserve_held, credit merchant_payable), the collection record carries the remainder, and the total covered always equals the negative balance\n`,
);
