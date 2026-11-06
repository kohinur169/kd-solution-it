// path: lib/payments/payout-execution.ts

/**
 * The payment core's payout execution: the service that sends money to a merchant's bank account through
 * the provider and notifies the merchant by email when the payout fails.
 *
 * ## What the execution is
 *
 * Section 10 says "failed payouts are reported to the merchant by email." A payout takes money from the
 * merchant's balance and sends it to the merchant's bank account through the provider. The provider
 * either sends the money (success), refuses (failed with a reason), or says it is still processing
 * (pending). The platform records the result and, when the payout fails, sends an email to the
 * merchant so they know the money did not arrive.
 *
 * The provider call is the execution. The provider implementation is an adapter concern (STEPs 147-169);
 * this file defines the port the adapter implements. The core service holds the seam: it validates, calls
 * the provider, records the result, and sends the failure email.
 *
 * ## What this file is not
 *
 * It is not the payout threshold check (STEP 142 owns that — the caller checks before calling this). It
 * is not the cooling period pause check (STEP 141 owns that). It is not the email system itself (STEPs
 * 221-230 own that — this file uses a function port). It is not the API route or the background job that
 * triggers payouts. This file is the core service: the execution record, the provider call, and the
 * failure email.
 */

import { randomUUID } from "node:crypto";

/** The lifecycle of a payout execution. */
export type PayoutStatus = "pending" | "success" | "failed";

/** A payout execution: the record of sending money to a bank account through the provider. */
export interface PayoutExecution {
  readonly id: string;
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly bankAccountId: string;
  readonly providerBankAccountId: string;
  readonly providerName: string;
  readonly status: PayoutStatus;
  readonly errorMessage: string | null;
  readonly emailSent: boolean;
  readonly createdAtEpochMs: number;
  readonly completedAtEpochMs: number | null;
}

/** What the provider's payout function returns. */
export type ProviderPayoutResult =
  | { status: "success"; providerPayoutId: string }
  | { status: "failed"; reason: string }
  | { status: "pending" };

/** The input the provider's payout function receives. */
export interface ProviderPayoutInput {
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly providerBankAccountId: string;
}

/** The provider payout port: the function the adapter implements. The core calls it, the adapter answers. */
export type ProviderPayoutFn = (input: ProviderPayoutInput) => ProviderPayoutResult;

/** The input to the email notification function. */
export interface EmailNotificationInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** The email notification port: the function that sends the failure email. The core calls it, the email system answers. */
export type EmailNotificationFn = (input: EmailNotificationInput) => void;

/** What the store reads and writes: the payout execution records. The store is the caller's. */
export interface PayoutExecutionStore {
  /** Store an execution record, replacing any record with the same id. */
  insert(execution: PayoutExecution): void;
  /** The record an id already holds, or null when the record is new. */
  findById(id: string): PayoutExecution | null;
  /** Every record a company has, success and failed. */
  findByCompany(companyId: string): PayoutExecution[];
  /** Every failed record a company has — the ones the merchant was notified about. */
  findFailedByCompany(companyId: string): PayoutExecution[];
}

/** The in-memory store: a reference implementation that keys on execution id. */
export class InMemoryPayoutExecutionStore implements PayoutExecutionStore {
  private readonly executions = new Map<string, PayoutExecution>();

  insert(execution: PayoutExecution): void {
    this.executions.set(execution.id, execution);
  }

  findById(id: string): PayoutExecution | null {
    return this.executions.get(id) ?? null;
  }

  findByCompany(companyId: string): PayoutExecution[] {
    return [...this.executions.values()].filter((execution) => execution.companyId === companyId);
  }

  findFailedByCompany(companyId: string): PayoutExecution[] {
    return this.findByCompany(companyId).filter((execution) => execution.status === "failed");
  }
}

/** The result of executing a payout. */
export type ExecutePayoutResult =
  | { status: "success"; execution: PayoutExecution }
  | { status: "failed"; execution: PayoutExecution }
  | { status: "pending"; execution: PayoutExecution }
  | { status: "rejected"; reason: string };

/** The input to the payout execution. */
export interface ExecutePayoutInput {
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly bankAccountId: string;
  readonly providerBankAccountId: string;
  readonly providerName: string;
  readonly merchantEmail: string;
}

/** Execute a payout: call the provider, record the result, send email on failure. */
export function executePayout(
  input: ExecutePayoutInput,
  options: {
    readonly store: PayoutExecutionStore;
    readonly executeProviderPayout: ProviderPayoutFn;
    readonly sendEmail: EmailNotificationFn;
    readonly occurredAtEpochMs: number;
  },
): ExecutePayoutResult {
  // 1. Validate.
  if (input.amountMinor <= 0n) {
    return { status: "rejected", reason: "the payout amount must be positive" };
  }
  if (input.merchantEmail.trim().length === 0) {
    return { status: "rejected", reason: "the merchant email is required for failure notification" };
  }

  // 2. Create the execution record as pending.
  const now = options.occurredAtEpochMs;
  const execution: PayoutExecution = {
    id: randomUUID(),
    companyId: input.companyId,
    amountMinor: input.amountMinor,
    bankAccountId: input.bankAccountId,
    providerBankAccountId: input.providerBankAccountId,
    providerName: input.providerName,
    status: "pending",
    errorMessage: null,
    emailSent: false,
    createdAtEpochMs: now,
    completedAtEpochMs: null,
  };
  options.store.insert(execution);

  // 3. Call the provider.
  const result = options.executeProviderPayout({
    companyId: input.companyId,
    amountMinor: input.amountMinor,
    providerBankAccountId: input.providerBankAccountId,
  });

  // 4. Record the result.
  if (result.status === "success") {
    const success: PayoutExecution = {
      ...execution,
      status: "success",
      completedAtEpochMs: now,
    };
    options.store.insert(success);
    return { status: "success", execution: success };
  }

  if (result.status === "pending") {
    const pending: PayoutExecution = {
      ...execution,
      status: "pending",
    };
    options.store.insert(pending);
    return { status: "pending", execution: pending };
  }

  // 5. Failed: record the failure, send email, update the record.
  const failed: PayoutExecution = {
    ...execution,
    status: "failed",
    errorMessage: result.reason,
    completedAtEpochMs: now,
  };
  options.store.insert(failed);

  options.sendEmail({
    to: input.merchantEmail,
    subject: "Payout failed",
    body: `Your payout was not sent to your bank account. Reason: ${result.reason}`,
  });

  const failedWithEmail: PayoutExecution = {
    ...failed,
    emailSent: true,
  };
  options.store.insert(failedWithEmail);

  return { status: "failed", execution: failedWithEmail };
}
