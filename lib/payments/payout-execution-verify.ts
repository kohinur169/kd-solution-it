// path: lib/payments/payout-execution-verify.ts
import process from "node:process";
import {
  InMemoryPayoutExecutionStore,
  executePayout,
  type ProviderPayoutInput,
  type ProviderPayoutResult,
  type EmailNotificationInput,
} from "./payout-execution.ts";

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

function successFn(): (input: ProviderPayoutInput) => ProviderPayoutResult {
  return () => ({ status: "success", providerPayoutId: "prov-payout-001" });
}

function failedFn(): (input: ProviderPayoutInput) => ProviderPayoutResult {
  return () => ({ status: "failed", reason: "insufficient funds at the bank" });
}

function pendingFn(): (input: ProviderPayoutInput) => ProviderPayoutResult {
  return () => ({ status: "pending" });
}

const validInput = {
  companyId: "company-1",
  amountMinor: 50_000n,
  bankAccountId: "bank-001",
  providerBankAccountId: "prov-bank-001",
  providerName: "payoneer",
  merchantEmail: "merchant@example.com",
};

/* ---- scenario 1: a valid payout is executed successfully ---- */

const store1 = new InMemoryPayoutExecutionStore();
const success = executePayout(validInput, {
  store: store1,
  executeProviderPayout: successFn(),
  sendEmail: () => {},
  occurredAtEpochMs: occurredAt,
});

expect(success.status === "success", "a valid payout is executed successfully");
if (success.status === "success") {
  expect(success.execution.status === "success", "the execution record has status success");
  expect(success.execution.errorMessage === null, "the error message is null on success");
  expect(success.execution.emailSent === false, "the email is not sent on success");
  expect(success.execution.completedAtEpochMs === occurredAt, "the completion time is recorded on success");
}

/* ---- scenario 2: the execution record is stored ---- */

if (success.status === "success") {
  expect(store1.findById(success.execution.id) !== null, "the execution record is stored in the store");
  expect(store1.findByCompany("company-1").length === 1, "the execution record is findable by company");
}

/* ---- scenario 3: a zero amount is rejected ---- */

const store3 = new InMemoryPayoutExecutionStore();
const zero = executePayout({ ...validInput, amountMinor: 0n }, {
  store: store3,
  executeProviderPayout: successFn(),
  sendEmail: () => {},
  occurredAtEpochMs: occurredAt,
});
expect(zero.status === "rejected", "a zero amount is rejected");

/* ---- scenario 4: a negative amount is rejected ---- */

const store4 = new InMemoryPayoutExecutionStore();
const negative = executePayout({ ...validInput, amountMinor: -100n }, {
  store: store4,
  executeProviderPayout: successFn(),
  sendEmail: () => {},
  occurredAtEpochMs: occurredAt,
});
expect(negative.status === "rejected", "a negative amount is rejected");

/* ---- scenario 5: an empty merchant email is rejected ---- */

const store5 = new InMemoryPayoutExecutionStore();
const emptyEmail = executePayout({ ...validInput, merchantEmail: "  " }, {
  store: store5,
  executeProviderPayout: successFn(),
  sendEmail: () => {},
  occurredAtEpochMs: occurredAt,
});
expect(emptyEmail.status === "rejected", "an empty merchant email is rejected");

/* ---- scenario 6: a failed provider payout records the failure and sends email ---- */

const store6 = new InMemoryPayoutExecutionStore();
const sentEmails: EmailNotificationInput[] = [];
const failed = executePayout(validInput, {
  store: store6,
  executeProviderPayout: failedFn(),
  sendEmail: (input) => { sentEmails.push(input); },
  occurredAtEpochMs: occurredAt,
});

expect(failed.status === "failed", "a failed provider payout returns failed");
if (failed.status === "failed") {
  expect(failed.execution.status === "failed", "the execution record has status failed");
  expect(failed.execution.errorMessage === "insufficient funds at the bank", "the error message is stored on failure");
  expect(failed.execution.emailSent === true, "the email is marked as sent on failure");
  expect(failed.execution.completedAtEpochMs === occurredAt, "the completion time is recorded on failure");
}

/* ---- scenario 7: the email is sent to the merchant ---- */

expect(sentEmails.length === 1, "an email is sent on failure");
if (sentEmails.length === 1) {
  const email = sentEmails[0];
  if (email !== undefined) {
    expect(email.to === "merchant@example.com", "the email is sent to the merchant");
    expect(email.subject === "Payout failed", "the email subject is about the failure");
    expect(email.body.includes("insufficient funds"), "the email body includes the failure reason");
  }
}

/* ---- scenario 8: a pending provider payout keeps the record as pending ---- */

const store8 = new InMemoryPayoutExecutionStore();
const pending = executePayout(validInput, {
  store: store8,
  executeProviderPayout: pendingFn(),
  sendEmail: () => {},
  occurredAtEpochMs: occurredAt,
});

expect(pending.status === "pending", "a pending provider payout returns pending");
if (pending.status === "pending") {
  expect(pending.execution.status === "pending", "the execution record has status pending");
  expect(pending.execution.completedAtEpochMs === null, "the completion time is null on pending");
  expect(pending.execution.emailSent === false, "no email is sent on pending");
}

/* ---- scenario 9: multiple payouts can be executed for the same company ---- */

const store9 = new InMemoryPayoutExecutionStore();
executePayout(validInput, { store: store9, executeProviderPayout: successFn(), sendEmail: () => {}, occurredAtEpochMs: occurredAt });
executePayout({ ...validInput, amountMinor: 30_000n }, { store: store9, executeProviderPayout: successFn(), sendEmail: () => {}, occurredAtEpochMs: occurredAt + 1_000 });
executePayout({ ...validInput, amountMinor: 20_000n }, { store: store9, executeProviderPayout: failedFn(), sendEmail: () => {}, occurredAtEpochMs: occurredAt + 2_000 });

expect(store9.findByCompany("company-1").length === 3, "three payouts are stored for the same company");
expect(store9.findFailedByCompany("company-1").length === 1, "one payout is failed");

/* ---- scenario 10: the execution carries the right metadata ---- */

if (success.status === "success") {
  expect(success.execution.companyId === "company-1", "the execution carries the right company");
  expect(success.execution.amountMinor === 50_000n, "the execution carries the right amount");
  expect(success.execution.bankAccountId === "bank-001", "the execution carries the right bank account id");
  expect(success.execution.providerBankAccountId === "prov-bank-001", "the execution carries the right provider bank account id");
  expect(success.execution.providerName === "payoneer", "the execution carries the right provider name");
}

/* ---- scenario 11: two executions have different ids ---- */

const store11 = new InMemoryPayoutExecutionStore();
const r1 = executePayout(validInput, { store: store11, executeProviderPayout: successFn(), sendEmail: () => {}, occurredAtEpochMs: occurredAt });
const r2 = executePayout({ ...validInput, amountMinor: 30_000n }, { store: store11, executeProviderPayout: successFn(), sendEmail: () => {}, occurredAtEpochMs: occurredAt + 1_000 });
if (r1.status === "success" && r2.status === "success") {
  expect(r1.execution.id !== r2.execution.id, "two executions have different ids");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments payout execution gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments payout execution gate passed: ${checks} checks, a service that sends money to a merchant's bank account through the provider and notifies the merchant by email when the payout fails - the execution record carries the provider bank account id, the result status, the error message, and the email-sent flag, and a failed payout triggers an email with the failure reason\n`,
);
