// path: lib/payments/bank-change-verification-verify.ts
import process from "node:process";
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

/** A valid change request input. */
function makeInput(companyId: string, currentBankId: string) {
  return {
    companyId,
    currentBankAccountId: currentBankId,
    newAccountHolderName: "New Holder",
    newBankName: "New Bank",
    newAccountNumber: "222222222",
    newRoutingNumber: "021000021",
    newSwiftCode: null,
    newCurrency: "USD",
    providerName: "payoneer",
  };
}

/* ---- scenario 1: a valid bank change request is submitted ---- */

const store1 = new InMemoryBankChangeRequestStore();
const bankStore1 = new InMemoryPayoutBankAccountStore();
const currentBankId1 = makeCurrentBank(bankStore1, "company-1");
const submitted = submitBankChangeRequest(makeInput("company-1", currentBankId1), {
  store: store1,
  bankAccountStore: bankStore1,
  occurredAtEpochMs: occurredAt,
});

expect(submitted.status === "submitted", "a valid bank change request is submitted");
if (submitted.status === "submitted") {
  expect(submitted.request.status === "pending", "the request starts in the pending state");
  expect(submitted.request.newAccountHolderName === "New Holder", "the request carries the new account holder name");
  expect(submitted.request.newBankName === "New Bank", "the request carries the new bank name");
  expect(submitted.request.newCurrency === "USD", "the request carries the normalized currency");
  expect(submitted.request.verifiedBy === null, "the request has no verifier while pending");
  expect(submitted.request.newBankAccountId === null, "the request has no new bank account id while pending");
}

/* ---- scenario 2: the request is stored ---- */

if (submitted.status === "submitted") {
  expect(store1.findById(submitted.request.id) !== null, "the request is stored in the store");
  expect(store1.findPendingByCompany("company-1").length === 1, "the request is findable as pending by company");
}

/* ---- scenario 3: an empty account holder name is rejected ---- */

const store3 = new InMemoryBankChangeRequestStore();
const bankStore3 = new InMemoryPayoutBankAccountStore();
const currentBankId3 = makeCurrentBank(bankStore3, "company-1");
const emptyHolder = submitBankChangeRequest({ ...makeInput("company-1", currentBankId3), newAccountHolderName: "  " }, {
  store: store3,
  bankAccountStore: bankStore3,
  occurredAtEpochMs: occurredAt,
});
expect(emptyHolder.status === "failed", "an empty new account holder name is rejected");

/* ---- scenario 4: an empty bank name is rejected ---- */

const store4 = new InMemoryBankChangeRequestStore();
const bankStore4 = new InMemoryPayoutBankAccountStore();
const currentBankId4 = makeCurrentBank(bankStore4, "company-1");
const emptyBank = submitBankChangeRequest({ ...makeInput("company-1", currentBankId4), newBankName: " " }, {
  store: store4,
  bankAccountStore: bankStore4,
  occurredAtEpochMs: occurredAt,
});
expect(emptyBank.status === "failed", "an empty new bank name is rejected");

/* ---- scenario 5: an invalid account number is rejected ---- */

const store5 = new InMemoryBankChangeRequestStore();
const bankStore5 = new InMemoryPayoutBankAccountStore();
const currentBankId5 = makeCurrentBank(bankStore5, "company-1");
const badAccount = submitBankChangeRequest({ ...makeInput("company-1", currentBankId5), newAccountNumber: "abc" }, {
  store: store5,
  bankAccountStore: bankStore5,
  occurredAtEpochMs: occurredAt,
});
expect(badAccount.status === "failed", "an invalid new account number is rejected");

/* ---- scenario 6: no routing or SWIFT code is rejected ---- */

const store6 = new InMemoryBankChangeRequestStore();
const bankStore6 = new InMemoryPayoutBankAccountStore();
const currentBankId6 = makeCurrentBank(bankStore6, "company-1");
const noRouting = submitBankChangeRequest({ ...makeInput("company-1", currentBankId6), newRoutingNumber: null, newSwiftCode: null }, {
  store: store6,
  bankAccountStore: bankStore6,
  occurredAtEpochMs: occurredAt,
});
expect(noRouting.status === "failed", "no new routing or SWIFT code is rejected");

/* ---- scenario 7: an invalid currency is rejected ---- */

const store7 = new InMemoryBankChangeRequestStore();
const bankStore7 = new InMemoryPayoutBankAccountStore();
const currentBankId7 = makeCurrentBank(bankStore7, "company-1");
const badCurrency = submitBankChangeRequest({ ...makeInput("company-1", currentBankId7), newCurrency: "US" }, {
  store: store7,
  bankAccountStore: bankStore7,
  occurredAtEpochMs: occurredAt,
});
expect(badCurrency.status === "failed", "an invalid new currency is rejected");

/* ---- scenario 8: a bad provider name is rejected ---- */

const store8 = new InMemoryBankChangeRequestStore();
const bankStore8 = new InMemoryPayoutBankAccountStore();
const currentBankId8 = makeCurrentBank(bankStore8, "company-1");
const badProvider = submitBankChangeRequest({ ...makeInput("company-1", currentBankId8), providerName: "stripe" }, {
  store: store8,
  bankAccountStore: bankStore8,
  occurredAtEpochMs: occurredAt,
});
expect(badProvider.status === "failed", "a non-payout provider is rejected");

/* ---- scenario 9: a non-existent current bank account is rejected ---- */

const store9 = new InMemoryBankChangeRequestStore();
const bankStore9 = new InMemoryPayoutBankAccountStore();
const noCurrent = submitBankChangeRequest(makeInput("company-1", "nonexistent"), {
  store: store9,
  bankAccountStore: bankStore9,
  occurredAtEpochMs: occurredAt,
});
expect(noCurrent.status === "failed", "a non-existent current bank account is rejected");

/* ---- scenario 10: approve creates a new bank account ---- */

const store10 = new InMemoryBankChangeRequestStore();
const bankStore10 = new InMemoryPayoutBankAccountStore();
const currentBankId10 = makeCurrentBank(bankStore10, "company-1");
const r10 = submitBankChangeRequest(makeInput("company-1", currentBankId10), {
  store: store10,
  bankAccountStore: bankStore10,
  occurredAtEpochMs: occurredAt,
});

if (r10.status === "submitted") {
  const approved = verifyBankChangeRequest(r10.request.id, {
    decision: "approve",
    verifierId: "office-user-1",
    note: "Verified against KYC documents",
    store: store10,
    bankAccountStore: bankStore10,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });

  expect(approved.status === "approved", "approving a pending request creates the new bank account");
  if (approved.status === "approved") {
    expect(approved.request.status === "approved", "the request is marked approved");
    expect(approved.request.newBankAccountId === approved.newAccount.id, "the request carries the new bank account id");
    expect(approved.request.verifiedBy === "office-user-1", "the verifier is recorded");
    expect(approved.request.verifiedAtEpochMs === occurredAt + 1_000, "the verification time is recorded");
    expect(approved.request.verificationNote === "Verified against KYC documents", "the verification note is stored");
    expect(bankStore10.findById(approved.newAccount.id) !== null, "the new bank account is stored in the bank account store");
    expect(bankStore10.findActiveByCompany("company-1")?.accountNumber === "222222222", "the new bank account becomes the active one");
  }
}

/* ---- scenario 11: reject does not create a new bank account ---- */

const store11 = new InMemoryBankChangeRequestStore();
const bankStore11 = new InMemoryPayoutBankAccountStore();
const currentBankId11 = makeCurrentBank(bankStore11, "company-1");
const r11 = submitBankChangeRequest(makeInput("company-1", currentBankId11), {
  store: store11,
  bankAccountStore: bankStore11,
  occurredAtEpochMs: occurredAt,
});

if (r11.status === "submitted") {
  const rejected = verifyBankChangeRequest(r11.request.id, {
    decision: "reject",
    verifierId: "office-user-2",
    note: "Bank details do not match",
    store: store11,
    bankAccountStore: bankStore11,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });

  expect(rejected.status === "rejected", "rejecting a pending request marks it rejected");
  if (rejected.status === "rejected") {
    expect(rejected.request.status === "rejected", "the request is marked rejected");
    expect(rejected.request.verifiedBy === "office-user-2", "the verifier is recorded on rejection");
    expect(rejected.request.verificationNote === "Bank details do not match", "the rejection note is stored");
    expect(bankStore11.findByCompany("company-1").length === 1, "no new bank account is created on rejection");
    expect(bankStore11.findActiveByCompany("company-1")?.accountNumber === "111111111", "the previous bank stays active after rejection");
  }
}

/* ---- scenario 12: verifying a non-existent request is rejected ---- */

const store12 = new InMemoryBankChangeRequestStore();
const bankStore12 = new InMemoryPayoutBankAccountStore();
const noRequest = verifyBankChangeRequest("nonexistent", {
  decision: "approve",
  verifierId: "office-user-1",
  note: null,
  store: store12,
  bankAccountStore: bankStore12,
  linkProviderBank: linkedFn(),
  occurredAtEpochMs: occurredAt,
});
expect(noRequest.status === "failed", "verifying a non-existent request is rejected");

/* ---- scenario 13: verifying a non-pending request is rejected ---- */

const store13 = new InMemoryBankChangeRequestStore();
const bankStore13 = new InMemoryPayoutBankAccountStore();
const currentBankId13 = makeCurrentBank(bankStore13, "company-1");
const r13 = submitBankChangeRequest(makeInput("company-1", currentBankId13), {
  store: store13,
  bankAccountStore: bankStore13,
  occurredAtEpochMs: occurredAt,
});

if (r13.status === "submitted") {
  verifyBankChangeRequest(r13.request.id, {
    decision: "reject",
    verifierId: "office-user-1",
    note: null,
    store: store13,
    bankAccountStore: bankStore13,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });

  const reVerify = verifyBankChangeRequest(r13.request.id, {
    decision: "approve",
    verifierId: "office-user-1",
    note: null,
    store: store13,
    bankAccountStore: bankStore13,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt + 2_000,
  });
  expect(reVerify.status === "failed", "verifying a non-pending request is rejected");
}

/* ---- scenario 14: a second pending request is rejected ---- */

const store14 = new InMemoryBankChangeRequestStore();
const bankStore14 = new InMemoryPayoutBankAccountStore();
const currentBankId14 = makeCurrentBank(bankStore14, "company-1");
const r14a = submitBankChangeRequest(makeInput("company-1", currentBankId14), {
  store: store14,
  bankAccountStore: bankStore14,
  occurredAtEpochMs: occurredAt,
});
const r14b = submitBankChangeRequest({ ...makeInput("company-1", currentBankId14), newAccountNumber: "333333333" }, {
  store: store14,
  bankAccountStore: bankStore14,
  occurredAtEpochMs: occurredAt + 1_000,
});
expect(r14a.status === "submitted", "the first request is submitted");
expect(r14b.status === "failed", "a second pending request is rejected");

/* ---- scenario 15: multiple requests after resolution ---- */

const store15 = new InMemoryBankChangeRequestStore();
const bankStore15 = new InMemoryPayoutBankAccountStore();
const currentBankId15 = makeCurrentBank(bankStore15, "company-1");
const r15 = submitBankChangeRequest(makeInput("company-1", currentBankId15), {
  store: store15,
  bankAccountStore: bankStore15,
  occurredAtEpochMs: occurredAt,
});

if (r15.status === "submitted") {
  verifyBankChangeRequest(r15.request.id, {
    decision: "reject",
    verifierId: "office-user-1",
    note: null,
    store: store15,
    bankAccountStore: bankStore15,
    linkProviderBank: linkedFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });
}

const r15b = submitBankChangeRequest({ ...makeInput("company-1", currentBankId15), newAccountNumber: "333333333" }, {
  store: store15,
  bankAccountStore: bankStore15,
  occurredAtEpochMs: occurredAt + 2_000,
});
expect(r15b.status === "submitted", "a new request can be submitted after the previous one is resolved");
expect(store15.findByCompany("company-1").length === 2, "two requests are stored for the same company");
expect(store15.findPendingByCompany("company-1").length === 1, "only the new request is pending");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments bank change verification gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments bank change verification gate passed: ${checks} checks, a service that gates switching the active payout bank account behind an office role's manual review - a submitted request is pending until verified, approval creates the new bank account and makes it active, rejection keeps the previous bank active and creates no new account, and a non-pending request cannot be verified again\n`,
);
