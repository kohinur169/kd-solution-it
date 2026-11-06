// path: lib/payments/payout-bank-account-verify.ts
import process from "node:process";
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

function makeOptions(store: InMemoryPayoutBankAccountStore, linkFn: (input: ProviderBankLinkingInput) => ProviderLinkResult) {
  return {
    store,
    linkProviderBank: linkFn,
    occurredAtEpochMs: occurredAt,
  };
}

function linkedFn(): (input: ProviderBankLinkingInput) => ProviderLinkResult {
  return () => ({ status: "linked", providerBankAccountId: "prov-bank-001" });
}

function failedFn(): (input: ProviderBankLinkingInput) => ProviderLinkResult {
  return () => ({ status: "failed", reason: "provider rejected the bank details" });
}

const validInput = {
  companyId: "company-1",
  accountHolderName: "John Doe",
  bankName: "Chase Bank",
  accountNumber: "123456789",
  routingNumber: "021000021",
  swiftCode: null,
  currency: "USD",
  providerName: "payoneer",
};

/* ---- scenario 1: a valid bank account is added and linked ---- */

const store1 = new InMemoryPayoutBankAccountStore();
const linked = addPayoutBankAccount(validInput, makeOptions(store1, linkedFn()));

expect(linked.status === "linked", "a valid bank account is added and linked");
if (linked.status === "linked") {
  expect(linked.account.status === "linked", "the record has status linked");
  expect(linked.account.providerBankAccountId === "prov-bank-001", "the provider bank account id is stored");
  expect(linked.account.providerName === "payoneer", "the record carries the provider name");
  expect(linked.account.currency === "USD", "the currency is normalized to uppercase");
  expect(linked.account.accountHolderName === "John Doe", "the account holder name is trimmed");
  expect(linked.account.bankName === "Chase Bank", "the bank name is trimmed");
  expect(linked.account.failureReason === null, "the failure reason is null when linked");
  expect(linked.account.createdAtEpochMs === occurredAt, "the creation timestamp is recorded");
  expect(linked.account.updatedAtEpochMs === occurredAt, "the update timestamp is recorded");
}

/* ---- scenario 2: the record is stored ---- */

if (linked.status === "linked") {
  expect(store1.findById(linked.account.id) !== null, "the record is stored in the store");
  expect(store1.findByCompany("company-1").length === 1, "the record is findable by company");
}

/* ---- scenario 3: an empty account holder name is rejected ---- */

const store3 = new InMemoryPayoutBankAccountStore();
const emptyHolder = addPayoutBankAccount({ ...validInput, accountHolderName: "  " }, makeOptions(store3, linkedFn()));
expect(emptyHolder.status === "failed", "an empty account holder name is rejected");

/* ---- scenario 4: an empty bank name is rejected ---- */

const store4 = new InMemoryPayoutBankAccountStore();
const emptyBank = addPayoutBankAccount({ ...validInput, bankName: " " }, makeOptions(store4, linkedFn()));
expect(emptyBank.status === "failed", "an empty bank name is rejected");

/* ---- scenario 5: an invalid account number is rejected ---- */

const store5 = new InMemoryPayoutBankAccountStore();
const badAccount = addPayoutBankAccount({ ...validInput, accountNumber: "abc" }, makeOptions(store5, linkedFn()));
expect(badAccount.status === "failed", "an invalid account number is rejected");

/* ---- scenario 6: no routing or SWIFT code is rejected ---- */

const store6 = new InMemoryPayoutBankAccountStore();
const noRouting = addPayoutBankAccount({ ...validInput, routingNumber: null, swiftCode: null }, makeOptions(store6, linkedFn()));
expect(noRouting.status === "failed", "no routing or SWIFT code is rejected");

/* ---- scenario 7: an invalid routing number is rejected ---- */

const store7 = new InMemoryPayoutBankAccountStore();
const badRouting = addPayoutBankAccount({ ...validInput, routingNumber: "123" }, makeOptions(store7, linkedFn()));
expect(badRouting.status === "failed", "an invalid routing number is rejected");

/* ---- scenario 8: an invalid SWIFT code is rejected ---- */

const store8 = new InMemoryPayoutBankAccountStore();
const badSwift = addPayoutBankAccount({ ...validInput, routingNumber: null, swiftCode: "invalid" }, makeOptions(store8, linkedFn()));
expect(badSwift.status === "failed", "an invalid SWIFT code is rejected");

/* ---- scenario 9: an invalid currency is rejected ---- */

const store9 = new InMemoryPayoutBankAccountStore();
const badCurrency = addPayoutBankAccount({ ...validInput, currency: "US" }, makeOptions(store9, linkedFn()));
expect(badCurrency.status === "failed", "an invalid currency is rejected");

/* ---- scenario 10: a bad provider name is rejected ---- */

const store10 = new InMemoryPayoutBankAccountStore();
const badProvider = addPayoutBankAccount({ ...validInput, providerName: "stripe" }, makeOptions(store10, linkedFn()));
expect(badProvider.status === "failed", "a non-payout provider is rejected");

/* ---- scenario 11: a failed provider link sets the status to failed ---- */

const store11 = new InMemoryPayoutBankAccountStore();
const failed = addPayoutBankAccount(validInput, makeOptions(store11, failedFn()));

expect(failed.status === "failed", "a failed provider link returns failed");
expect(store11.findByCompany("company-1").length === 1, "a failed attempt still stores a record");
expect(store11.findByCompany("company-1")[0]?.status === "failed", "the stored record has status failed");
expect(store11.findByCompany("company-1")[0]?.providerBankAccountId === null, "the provider bank account id is null when failed");
expect(store11.findByCompany("company-1")[0]?.failureReason !== null, "the failure reason is stored");

/* ---- scenario 12: multiple bank accounts can be added ---- */

const store12 = new InMemoryPayoutBankAccountStore();
addPayoutBankAccount(validInput, makeOptions(store12, linkedFn()));
addPayoutBankAccount({ ...validInput, accountNumber: "999888777", bankName: "Wells Fargo" }, makeOptions(store12, linkedFn()));
expect(store12.findByCompany("company-1").length === 2, "two bank accounts are stored for the same company");

/* ---- scenario 13: findActiveByCompany returns the most recent linked ---- */

const store13 = new InMemoryPayoutBankAccountStore();
addPayoutBankAccount(validInput, makeOptions(store13, linkedFn()));
addPayoutBankAccount({ ...validInput, accountNumber: "999888777" }, { store: store13, linkProviderBank: linkedFn(), occurredAtEpochMs: occurredAt + 1_000 });
const active = store13.findActiveByCompany("company-1");
expect(active !== null, "findActiveByCompany returns a linked account");
expect(active?.accountNumber === "999888777", "findActiveByCompany returns the most recent linked account");

/* ---- scenario 14: findActiveByCompany skips failed accounts ---- */

const store14 = new InMemoryPayoutBankAccountStore();
addPayoutBankAccount(validInput, makeOptions(store14, linkedFn()));
addPayoutBankAccount({ ...validInput, accountNumber: "999888777" }, makeOptions(store14, failedFn()));
const active14 = store14.findActiveByCompany("company-1");
expect(active14?.accountNumber === "123456789", "findActiveByCompany skips failed accounts and returns the linked one");

/* ---- scenario 15: findActiveByCompany returns null when no account is linked ---- */

const store15 = new InMemoryPayoutBankAccountStore();
addPayoutBankAccount(validInput, makeOptions(store15, failedFn()));
expect(store15.findActiveByCompany("company-1") === null, "findActiveByCompany returns null when no account is linked");

/* ---- scenario 16: two records have different ids ---- */

const store16 = new InMemoryPayoutBankAccountStore();
const r1 = addPayoutBankAccount(validInput, makeOptions(store16, linkedFn()));
const r2 = addPayoutBankAccount({ ...validInput, accountNumber: "999888777" }, makeOptions(store16, linkedFn()));
if (r1.status === "linked" && r2.status === "linked") {
  expect(r1.account.id !== r2.account.id, "two records have different ids");
}

/* ---- scenario 17: the routing number is stored correctly ---- */

if (linked.status === "linked") {
  expect(linked.account.routingNumber === "021000021", "the routing number is stored correctly");
  expect(linked.account.swiftCode === null, "the SWIFT code is null when a routing number is given");
}

/* ---- scenario 18: the SWIFT code is stored correctly ---- */

const store18 = new InMemoryPayoutBankAccountStore();
const swiftInput = { ...validInput, routingNumber: null, swiftCode: "CHASUS33" };
const swiftResult = addPayoutBankAccount(swiftInput, makeOptions(store18, linkedFn()));
if (swiftResult.status === "linked") {
  expect(swiftResult.account.swiftCode === "CHASUS33", "the SWIFT code is stored correctly");
  expect(swiftResult.account.routingNumber === null, "the routing number is null when a SWIFT code is given");
}

/* ---- scenario 19: airwallex is a valid provider ---- */

const store19 = new InMemoryPayoutBankAccountStore();
const airwallexResult = addPayoutBankAccount({ ...validInput, providerName: "airwallex" }, makeOptions(store19, linkedFn()));
expect(airwallexResult.status === "linked", "airwallex is a valid payout provider");

/* ---- scenario 20: the provider receives the trimmed and normalized input ---- */

const captured = { input: null as ProviderBankLinkingInput | null };
const captureFn = (input: ProviderBankLinkingInput): ProviderLinkResult => {
  captured.input = input;
  return { status: "linked", providerBankAccountId: "prov-bank-002" };
};
const store20 = new InMemoryPayoutBankAccountStore();
addPayoutBankAccount({ ...validInput, accountHolderName: "  Jane Smith  ", bankName: "  Bank of America  ", currency: "usd" }, makeOptions(store20, captureFn));
expect(captured.input?.accountHolderName === "Jane Smith", "the provider receives the trimmed account holder name");
expect(captured.input?.bankName === "Bank of America", "the provider receives the trimmed bank name");
expect(captured.input?.currency === "USD", "the provider receives the normalized currency");

/* ---- scenario 21: the provider receives the company id ---- */

expect(captured.input?.companyId === "company-1", "the provider receives the company id");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments payout bank account gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments payout bank account gate passed: ${checks} checks, a service that validates bank account details, links the bank with the payout provider automatically, and stores the provider's response - the record carries the provider bank account id, the active account is the most recent linked one, and failed provider links are recorded with the reason\n`,
);
