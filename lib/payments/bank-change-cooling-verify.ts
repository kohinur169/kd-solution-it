// path: lib/payments/bank-change-cooling-verify.ts
import process from "node:process";
import {
  InMemoryCoolingPeriodStore,
  startCoolingPeriod,
  checkPayoutPause,
  getCoolingPeriodEnd,
  COOLING_PERIOD_MS,
} from "./bank-change-cooling.ts";
import {
  InMemoryBankChangeRequestStore,
  submitBankChangeRequest,
  verifyBankChangeRequest,
} from "./bank-change-verification.ts";
import {
  InMemoryPayoutBankAccountStore,
  addPayoutBankAccount,
  type ProviderBankLinkingInput,
  type ProviderLinkResult,
} from "./payout-bank-account.ts";

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

function linkedFn(): (input: ProviderBankLinkingInput) => ProviderLinkResult {
  return () => ({ status: "linked", providerBankAccountId: "prov-bank-001" });
}

/** Create a linked bank account so the current bank exists. Returns the account id. */
function makeCurrentBank(store: InMemoryPayoutBankAccountStore, companyId: string): string {
  const result = addPayoutBankAccount(
    {
      companyId,
      accountHolderName: "Current Holder",
      bankName: "Current Bank",
      accountNumber: "111111111",
      routingNumber: "021000021",
      swiftCode: null,
      currency: "USD",
      providerName: "payoneer",
    },
    { store, linkProviderBank: linkedFn(), occurredAtEpochMs: occurredAt },
  );
  if (result.status !== "linked") {
    throw new Error("failed to create current bank account for test");
  }
  return result.account.id;
}

/** Create and approve a bank change request. Returns the request id. */
function makeApprovedRequest(
  requestStore: InMemoryBankChangeRequestStore,
  bankAccountStore: InMemoryPayoutBankAccountStore,
  companyId: string,
  currentBankId: string,
): string {
  const submitted = submitBankChangeRequest(
    {
      companyId,
      currentBankAccountId: currentBankId,
      newAccountHolderName: "New Holder",
      newBankName: "New Bank",
      newAccountNumber: "222222222",
      newRoutingNumber: "021000021",
      newSwiftCode: null,
      newCurrency: "USD",
      providerName: "payoneer",
    },
    { store: requestStore, bankAccountStore, occurredAtEpochMs: occurredAt },
  );
  if (submitted.status !== "submitted") {
    throw new Error("failed to submit bank change request for test");
  }
  const verified = verifyBankChangeRequest(submitted.request.id, {
    decision: "approve",
    verifierId: "office-user-1",
    note: null,
    store: requestStore,
    bankAccountStore,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt,
  });
  if (verified.status !== "approved") {
    throw new Error("failed to approve bank change request for test");
  }
  return submitted.request.id;
}

/* ---- scenario 1: a cooling period is started for an approved request ---- */

const store1 = new InMemoryCoolingPeriodStore();
const requestStore1 = new InMemoryBankChangeRequestStore();
const bankStore1 = new InMemoryPayoutBankAccountStore();
const currentBankId1 = makeCurrentBank(bankStore1, "company-1");
const approvedRequestId1 = makeApprovedRequest(requestStore1, bankStore1, "company-1", currentBankId1);
const started1 = startCoolingPeriod(approvedRequestId1, {
  store: store1,
  requestStore: requestStore1,
  occurredAtEpochMs: occurredAt,
});

expect(started1.status === "started", "a cooling period is started for an approved request");
if (started1.status === "started") {
  expect(started1.period.companyId === "company-1", "the cooling period carries the right company");
  expect(started1.period.requestId === approvedRequestId1, "the cooling period carries the right request id");
  expect(started1.period.startedAtEpochMs === occurredAt, "the cooling period carries the right start time");
  expect(started1.period.endsAtEpochMs === occurredAt + COOLING_PERIOD_MS, "the cooling period ends 96 hours after it starts");
  expect(started1.period.status === "active", "the cooling period starts in the active state");
}

/* ---- scenario 2: the cooling period is stored ---- */

if (started1.status === "started") {
  expect(store1.findById(started1.period.id) !== null, "the cooling period is stored in the store");
  expect(store1.findActiveByCompany("company-1") !== null, "the cooling period is findable as active by company");
}

/* ---- scenario 3: starting a cooling period for a non-approved request is rejected ---- */

const store3 = new InMemoryCoolingPeriodStore();
const requestStore3 = new InMemoryBankChangeRequestStore();
const bankStore3 = new InMemoryPayoutBankAccountStore();
const currentBankId3 = makeCurrentBank(bankStore3, "company-1");
const submitted3 = submitBankChangeRequest(
  {
    companyId: "company-1",
    currentBankAccountId: currentBankId3,
    newAccountHolderName: "New Holder",
    newBankName: "New Bank",
    newAccountNumber: "222222222",
    newRoutingNumber: "021000021",
    newSwiftCode: null,
    newCurrency: "USD",
    providerName: "payoneer",
  },
  { store: requestStore3, bankAccountStore: bankStore3, occurredAtEpochMs: occurredAt },
);

if (submitted3.status === "submitted") {
  const notApproved = startCoolingPeriod(submitted3.request.id, {
    store: store3,
    requestStore: requestStore3,
    occurredAtEpochMs: occurredAt,
  });
  expect(notApproved.status === "failed", "starting a cooling period for a non-approved request is rejected");
}

/* ---- scenario 4: starting a cooling period for a non-existent request is rejected ---- */

const store4 = new InMemoryCoolingPeriodStore();
const requestStore4 = new InMemoryBankChangeRequestStore();
const noRequest = startCoolingPeriod("nonexistent", {
  store: store4,
  requestStore: requestStore4,
  occurredAtEpochMs: occurredAt,
});
expect(noRequest.status === "failed", "starting a cooling period for a non-existent request is rejected");

/* ---- scenario 5: starting a cooling period when one is already active is rejected ---- */

const store5 = new InMemoryCoolingPeriodStore();
const requestStore5 = new InMemoryBankChangeRequestStore();
const bankStore5 = new InMemoryPayoutBankAccountStore();
const currentBankId5 = makeCurrentBank(bankStore5, "company-1");
const approvedRequestId5 = makeApprovedRequest(requestStore5, bankStore5, "company-1", currentBankId5);

if (started1.status === "started") {
  // Reuse store1's approved request — but we need a fresh store for scenario 5.
}

const started5a = startCoolingPeriod(approvedRequestId5, {
  store: store5,
  requestStore: requestStore5,
  occurredAtEpochMs: occurredAt,
});
expect(started5a.status === "started", "the first cooling period is started");

const requestStore5b = new InMemoryBankChangeRequestStore();
const bankStore5b = new InMemoryPayoutBankAccountStore();
const currentBankId5b = makeCurrentBank(bankStore5b, "company-1");
const approvedRequestId5b = makeApprovedRequest(requestStore5b, bankStore5b, "company-1", currentBankId5b);
const started5b = startCoolingPeriod(approvedRequestId5b, {
  store: store5,
  requestStore: requestStore5b,
  occurredAtEpochMs: occurredAt + 1_000,
});
expect(started5b.status === "failed", "starting a second cooling period while one is active is rejected");

/* ---- scenario 6: during the cooling period, payouts are paused ---- */

const store6 = new InMemoryCoolingPeriodStore();
const requestStore6 = new InMemoryBankChangeRequestStore();
const bankStore6 = new InMemoryPayoutBankAccountStore();
const currentBankId6 = makeCurrentBank(bankStore6, "company-1");
const approvedRequestId6 = makeApprovedRequest(requestStore6, bankStore6, "company-1", currentBankId6);
startCoolingPeriod(approvedRequestId6, {
  store: store6,
  requestStore: requestStore6,
  occurredAtEpochMs: occurredAt,
});

const duringPause = checkPayoutPause("company-1", occurredAt + 1_000, { store: store6 });
expect(duringPause.status === "paused", "during the cooling period payouts are paused");
if (duringPause.status === "paused") {
  expect(duringPause.endsAtEpochMs === occurredAt + COOLING_PERIOD_MS, "the pause carries the right end time");
  expect(duringPause.reason === "a bank change cooling period is active", "the pause carries the right reason");
}

/* ---- scenario 7: after the cooling period ends, payouts are allowed ---- */

const afterCooling = checkPayoutPause("company-1", occurredAt + COOLING_PERIOD_MS, { store: store6 });
expect(afterCooling.status === "allowed", "after the cooling period ends payouts are allowed");

const afterCoolingMore = checkPayoutPause("company-1", occurredAt + COOLING_PERIOD_MS + 1_000, { store: store6 });
expect(afterCoolingMore.status === "allowed", "payouts stay allowed after the cooling period expires");

/* ---- scenario 8: when there is no active cooling period, payouts are allowed ---- */

const store8 = new InMemoryCoolingPeriodStore();
const noPause = checkPayoutPause("company-1", occurredAt, { store: store8 });
expect(noPause.status === "allowed", "when there is no active cooling period payouts are allowed");

/* ---- scenario 9: the cooling period expires and updates its status ---- */

const store9 = new InMemoryCoolingPeriodStore();
const requestStore9 = new InMemoryBankChangeRequestStore();
const bankStore9 = new InMemoryPayoutBankAccountStore();
const currentBankId9 = makeCurrentBank(bankStore9, "company-1");
const approvedRequestId9 = makeApprovedRequest(requestStore9, bankStore9, "company-1", currentBankId9);
const started9 = startCoolingPeriod(approvedRequestId9, {
  store: store9,
  requestStore: requestStore9,
  occurredAtEpochMs: occurredAt,
});

if (started9.status === "started") {
  checkPayoutPause("company-1", occurredAt + COOLING_PERIOD_MS, { store: store9 });
  expect(store9.findById(started9.period.id)?.status === "expired", "the cooling period status is updated to expired");
  expect(store9.findActiveByCompany("company-1") === null, "no active cooling period remains after expiry");
}

/* ---- scenario 10: a new cooling period can start after the previous one expires ---- */

const store10 = new InMemoryCoolingPeriodStore();
const requestStore10 = new InMemoryBankChangeRequestStore();
const bankStore10 = new InMemoryPayoutBankAccountStore();
const currentBankId10 = makeCurrentBank(bankStore10, "company-1");
const approvedRequestId10a = makeApprovedRequest(requestStore10, bankStore10, "company-1", currentBankId10);
const started10a = startCoolingPeriod(approvedRequestId10a, {
  store: store10,
  requestStore: requestStore10,
  occurredAtEpochMs: occurredAt,
});

expect(started10a.status === "started", "the first cooling period is started");

// Expire the first period.
checkPayoutPause("company-1", occurredAt + COOLING_PERIOD_MS, { store: store10 });

// Create and approve a second request.
const requestStore10b = new InMemoryBankChangeRequestStore();
const bankStore10b = new InMemoryPayoutBankAccountStore();
const currentBankId10b = makeCurrentBank(bankStore10b, "company-1");
const approvedRequestId10b = makeApprovedRequest(requestStore10b, bankStore10b, "company-1", currentBankId10b);
const started10b = startCoolingPeriod(approvedRequestId10b, {
  store: store10,
  requestStore: requestStore10b,
  occurredAtEpochMs: occurredAt + COOLING_PERIOD_MS + 1_000,
});

expect(started10b.status === "started", "a new cooling period can start after the previous one expires");

/* ---- scenario 11: getCoolingPeriodEnd returns the end time or null ---- */

const store11 = new InMemoryCoolingPeriodStore();
const noEnd = getCoolingPeriodEnd("company-1", occurredAt, { store: store11 });
expect(noEnd === null, "getCoolingPeriodEnd returns null when no period is active");

const requestStore11 = new InMemoryBankChangeRequestStore();
const bankStore11 = new InMemoryPayoutBankAccountStore();
const currentBankId11 = makeCurrentBank(bankStore11, "company-1");
const approvedRequestId11 = makeApprovedRequest(requestStore11, bankStore11, "company-1", currentBankId11);
startCoolingPeriod(approvedRequestId11, {
  store: store11,
  requestStore: requestStore11,
  occurredAtEpochMs: occurredAt,
});

const endTime = getCoolingPeriodEnd("company-1", occurredAt + 1_000, { store: store11 });
expect(endTime === occurredAt + COOLING_PERIOD_MS, "getCoolingPeriodEnd returns the right end time");

/* ---- scenario 12: the cooling period carries the new bank account id ---- */

if (started1.status === "started") {
  expect(started1.period.newBankAccountId !== "", "the cooling period carries the new bank account id");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments bank change cooling gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments bank change cooling gate passed: ${checks} checks, a service that enforces the 96 hour cooling period after a bank change approval - payouts are fully paused for the company during the period including to the previous bank, the period expires after 96 hours and payouts resume, a second period cannot start while one is active, and a new period can start after the previous one expires\n`,
);
