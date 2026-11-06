// path: lib/payments/payout-bank-account.ts

/**
 * The payment core's payout bank account add flow: the service that adds a bank account to a merchant's
 * payout profile and links it with the provider automatically.
 *
 * ## What the add flow is
 *
 * Section 10 says "merchants add a payout bank account in profile payout settings. The bank is added
 * automatically to Payoneer or Airwallex." A merchant names an account holder, a bank, an account
 * number, and either a routing number or a SWIFT code. The platform validates the details, then calls
 * the provider's bank linking function - the same provider the routing engine (STEP 129) chose for
 * payouts. The provider creates a bank account in its own system and returns a provider bank account
 * id. The platform stores that id with the record, so the payout job can reference it later.
 *
 * The provider call is the automatic linking. The merchant does not go to Payoneer or Airwallex to add
 * the bank account themselves - the platform does it. The core service holds the seam: it validates,
 * calls the provider, and stores the result. The provider implementation is an adapter concern (STEPs
 * 147-169); this file defines the port the adapter implements.
 *
 * ## What this file is not
 *
 * It is not the API route or the UI for the payout settings page. It is not the payout job that
 * actually sends money to the bank account. It is not the bank change verification flow (STEP 140)
 * that gates switching the active bank. It is not the provider adapter itself. This file is the core
 * service: validation, provider call, and record storage.
 */

import { randomUUID } from "node:crypto";

/** The providers that can receive a payout bank account link. Payoneer is payouts only; Airwallex does payouts and more. */
const VALID_PAYOUT_PROVIDERS = new Set(["payoneer", "airwallex"]);

/** The lifecycle of a payout bank account record. */
export type PayoutBankAccountStatus = "pending" | "linked" | "failed";

/** A payout bank account: the bank details a merchant added and the provider's response. */
export interface PayoutBankAccount {
  readonly id: string;
  readonly companyId: string;
  readonly accountHolderName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly routingNumber: string | null;
  readonly swiftCode: string | null;
  readonly currency: string;
  readonly providerName: string;
  readonly providerBankAccountId: string | null;
  readonly status: PayoutBankAccountStatus;
  readonly failureReason: string | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the provider's bank linking function returns. */
export type ProviderLinkResult =
  | { status: "linked"; providerBankAccountId: string }
  | { status: "failed"; reason: string };

/** The input the provider's bank linking function receives. */
export interface ProviderBankLinkingInput {
  readonly companyId: string;
  readonly accountHolderName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly routingNumber: string | null;
  readonly swiftCode: string | null;
  readonly currency: string;
}

/** The provider bank linking port: the function the adapter implements. The core calls it, the adapter answers. */
export type ProviderBankLinkingFn = (input: ProviderBankLinkingInput) => ProviderLinkResult;

/** What the add flow service reads and writes: the payout bank account records. The store is the caller's. */
export interface PayoutBankAccountStore {
  /** Store a bank account record, replacing any record with the same id. */
  insert(account: PayoutBankAccount): void;
  /** The record an id already holds, or null when the record is new. */
  findById(id: string): PayoutBankAccount | null;
  /** Every record a company has, linked and failed. */
  findByCompany(companyId: string): PayoutBankAccount[];
  /** The active account a company has: the most recent linked account, or null when none is linked. */
  findActiveByCompany(companyId: string): PayoutBankAccount | null;
}

/** The in-memory store: a reference implementation that keys on record id. */
export class InMemoryPayoutBankAccountStore implements PayoutBankAccountStore {
  private readonly accounts = new Map<string, PayoutBankAccount>();

  insert(account: PayoutBankAccount): void {
    this.accounts.set(account.id, account);
  }

  findById(id: string): PayoutBankAccount | null {
    return this.accounts.get(id) ?? null;
  }

  findByCompany(companyId: string): PayoutBankAccount[] {
    return [...this.accounts.values()].filter((account) => account.companyId === companyId);
  }

  findActiveByCompany(companyId: string): PayoutBankAccount | null {
    const linked = this.findByCompany(companyId).filter((account) => account.status === "linked");
    linked.sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs);
    return linked[0] ?? null;
  }
}

/** The result of adding a payout bank account. */
export type AddPayoutBankAccountResult =
  | { status: "linked"; account: PayoutBankAccount }
  | { status: "failed"; reason: string };

/** The input to the add flow: the bank details the merchant provided and the provider that handles payouts. */
export interface AddPayoutBankAccountInput {
  readonly companyId: string;
  readonly accountHolderName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly routingNumber: string | null;
  readonly swiftCode: string | null;
  readonly currency: string;
  readonly providerName: string;
}

/** Add a payout bank account: validate, link with the provider, store the record. */
export function addPayoutBankAccount(
  input: AddPayoutBankAccountInput,
  options: {
    readonly store: PayoutBankAccountStore;
    readonly linkProviderBank: ProviderBankLinkingFn;
    readonly occurredAtEpochMs: number;
  },
): AddPayoutBankAccountResult {
  // 1. Validate the bank details.
  if (input.accountHolderName.trim().length === 0) {
    return { status: "failed", reason: "the account holder name must not be empty" };
  }
  if (input.bankName.trim().length === 0) {
    return { status: "failed", reason: "the bank name must not be empty" };
  }
  if (!/^\d{6,34}$/.test(input.accountNumber)) {
    return { status: "failed", reason: "the account number must be 6 to 34 digits" };
  }
  if (input.routingNumber === null && input.swiftCode === null) {
    return { status: "failed", reason: "either a routing number or a SWIFT code is required" };
  }
  if (input.routingNumber !== null && !/^\d{9}$/.test(input.routingNumber)) {
    return { status: "failed", reason: "the routing number must be 9 digits" };
  }
  if (input.swiftCode !== null && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input.swiftCode)) {
    return { status: "failed", reason: "the SWIFT code is not valid" };
  }
  if (!/^[A-Z]{3}$/.test(input.currency.toUpperCase())) {
    return { status: "failed", reason: "the currency must be a 3-letter ISO 4217 code" };
  }
  if (!VALID_PAYOUT_PROVIDERS.has(input.providerName)) {
    return { status: "failed", reason: "the provider must be payoneer or airwallex" };
  }

  // 2. Call the provider's bank linking function.
  const linkResult = options.linkProviderBank({
    companyId: input.companyId,
    accountHolderName: input.accountHolderName.trim(),
    bankName: input.bankName.trim(),
    accountNumber: input.accountNumber,
    routingNumber: input.routingNumber,
    swiftCode: input.swiftCode,
    currency: input.currency.toUpperCase(),
  });

  // 3. Store the record with the provider's response.
  const now = options.occurredAtEpochMs;

  if (linkResult.status === "linked") {
    const account: PayoutBankAccount = {
      id: randomUUID(),
      companyId: input.companyId,
      accountHolderName: input.accountHolderName.trim(),
      bankName: input.bankName.trim(),
      accountNumber: input.accountNumber,
      routingNumber: input.routingNumber,
      swiftCode: input.swiftCode,
      currency: input.currency.toUpperCase(),
      providerName: input.providerName,
      providerBankAccountId: linkResult.providerBankAccountId,
      status: "linked",
      failureReason: null,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
    };
    options.store.insert(account);
    return { status: "linked", account };
  }

  const account: PayoutBankAccount = {
    id: randomUUID(),
    companyId: input.companyId,
    accountHolderName: input.accountHolderName.trim(),
    bankName: input.bankName.trim(),
    accountNumber: input.accountNumber,
    routingNumber: input.routingNumber,
    swiftCode: input.swiftCode,
    currency: input.currency.toUpperCase(),
    providerName: input.providerName,
    providerBankAccountId: null,
    status: "failed",
    failureReason: linkResult.reason,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
  };
  options.store.insert(account);
  return { status: "failed", reason: linkResult.reason };
}
