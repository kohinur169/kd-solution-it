// path: lib/payments/bank-change-verification.ts

/**
 * The payment core's bank change manual verification flow: the service that gates switching a merchant's
 * active payout bank account behind an office role's manual review.
 *
 * ## What the flow is
 *
 * Section 10 says "changing a bank account requires manual verification first" and "when manual
 * verification fails, the cooling period never starts and the previous bank stays active." A merchant
 * who wants to switch their payout bank submits a change request with the new bank details. The request
 * is stored as pending — nothing happens to the current bank account yet. An office role then reviews
 * the request and either approves or rejects it.
 *
 * Approval is the only path that creates a new bank account. When the office role approves, the service
 * calls the payout bank account add flow (STEP 139) to register the new bank with the provider and
 * create the account. The new account becomes the active one. The request is marked approved and
 * carries the new account id.
 *
 * Rejection is the no-op path. When the office role rejects, the request is marked rejected and no new
 * bank account is created. The previous bank stays active — the merchant's existing payout bank is
 * untouched. The cooling period (STEP 141) never starts because it only begins after approval.
 *
 * ## What this file is not
 *
 * It is not the cooling period enforcement (STEP 141 owns that). It is not the API route or UI for
 * submitting or reviewing bank change requests. It is not the payout bank account add flow itself
 * (STEP 139 owns that — this file calls it). It is not the provider adapter. This file is the core
 * service: the pending request, the approve/reject decision, and the link to the new account.
 */

import { randomUUID } from "node:crypto";
import {
  addPayoutBankAccount,
  type PayoutBankAccount,
  type PayoutBankAccountStore,
  type ProviderBankLinkingFn,
} from "./payout-bank-account.ts";

/** The lifecycle of a bank change request. */
export type BankChangeRequestStatus = "pending" | "approved" | "rejected";

/** A bank change request: the new bank details a merchant submitted and the office role's decision. */
export interface BankChangeRequest {
  readonly id: string;
  readonly companyId: string;
  readonly currentBankAccountId: string;
  readonly newAccountHolderName: string;
  readonly newBankName: string;
  readonly newAccountNumber: string;
  readonly newRoutingNumber: string | null;
  readonly newSwiftCode: string | null;
  readonly newCurrency: string;
  readonly providerName: string;
  readonly status: BankChangeRequestStatus;
  readonly verifiedBy: string | null;
  readonly verifiedAtEpochMs: number | null;
  readonly verificationNote: string | null;
  readonly newBankAccountId: string | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the store reads and writes: the bank change requests. The store is the caller's. */
export interface BankChangeRequestStore {
  /** Store a request, replacing any request with the same id. */
  insert(request: BankChangeRequest): void;
  /** The request an id already holds, or null when the request is new. */
  findById(id: string): BankChangeRequest | null;
  /** Every request a company has, pending and decided. */
  findByCompany(companyId: string): BankChangeRequest[];
  /** Every pending request a company has — the ones the office still needs to review. */
  findPendingByCompany(companyId: string): BankChangeRequest[];
}

/** The in-memory store: a reference implementation that keys on request id. */
export class InMemoryBankChangeRequestStore implements BankChangeRequestStore {
  private readonly requests = new Map<string, BankChangeRequest>();

  insert(request: BankChangeRequest): void {
    this.requests.set(request.id, request);
  }

  findById(id: string): BankChangeRequest | null {
    return this.requests.get(id) ?? null;
  }

  findByCompany(companyId: string): BankChangeRequest[] {
    return [...this.requests.values()].filter((request) => request.companyId === companyId);
  }

  findPendingByCompany(companyId: string): BankChangeRequest[] {
    return this.findByCompany(companyId).filter((request) => request.status === "pending");
  }
}

/** The input to submitting a bank change request: the current bank account and the new bank details. */
export interface SubmitBankChangeInput {
  readonly companyId: string;
  readonly currentBankAccountId: string;
  readonly newAccountHolderName: string;
  readonly newBankName: string;
  readonly newAccountNumber: string;
  readonly newRoutingNumber: string | null;
  readonly newSwiftCode: string | null;
  readonly newCurrency: string;
  readonly providerName: string;
}

/** The result of submitting a bank change request. */
export type SubmitBankChangeResult =
  | { status: "submitted"; request: BankChangeRequest }
  | { status: "failed"; reason: string };

const VALID_PAYOUT_PROVIDERS = new Set(["payoneer", "airwallex"]);

/** Submit a bank change request: validate the new bank details, store the request as pending. */
export function submitBankChangeRequest(
  input: SubmitBankChangeInput,
  options: {
    readonly store: BankChangeRequestStore;
    readonly bankAccountStore: PayoutBankAccountStore;
    readonly occurredAtEpochMs: number;
  },
): SubmitBankChangeResult {
  // 1. Validate the new bank details.
  if (input.newAccountHolderName.trim().length === 0) {
    return { status: "failed", reason: "the new account holder name must not be empty" };
  }
  if (input.newBankName.trim().length === 0) {
    return { status: "failed", reason: "the new bank name must not be empty" };
  }
  if (!/^\d{6,34}$/.test(input.newAccountNumber)) {
    return { status: "failed", reason: "the new account number must be 6 to 34 digits" };
  }
  if (input.newRoutingNumber === null && input.newSwiftCode === null) {
    return { status: "failed", reason: "either a new routing number or a new SWIFT code is required" };
  }
  if (input.newRoutingNumber !== null && !/^\d{9}$/.test(input.newRoutingNumber)) {
    return { status: "failed", reason: "the new routing number must be 9 digits" };
  }
  if (input.newSwiftCode !== null && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(input.newSwiftCode)) {
    return { status: "failed", reason: "the new SWIFT code is not valid" };
  }
  if (!/^[A-Z]{3}$/.test(input.newCurrency.toUpperCase())) {
    return { status: "failed", reason: "the new currency must be a 3-letter ISO 4217 code" };
  }
  if (!VALID_PAYOUT_PROVIDERS.has(input.providerName)) {
    return { status: "failed", reason: "the provider must be payoneer or airwallex" };
  }

  // 2. Check that the current bank account exists and is linked.
  const currentAccount = options.bankAccountStore.findById(input.currentBankAccountId);
  if (currentAccount === null || currentAccount.status !== "linked") {
    return { status: "failed", reason: "the current bank account does not exist or is not linked" };
  }

  // 3. Check that there is no already-pending request for the same company.
  if (options.store.findPendingByCompany(input.companyId).length > 0) {
    return { status: "failed", reason: "a bank change request is already pending for this company" };
  }

  // 4. Store the request as pending.
  const now = options.occurredAtEpochMs;
  const request: BankChangeRequest = {
    id: randomUUID(),
    companyId: input.companyId,
    currentBankAccountId: input.currentBankAccountId,
    newAccountHolderName: input.newAccountHolderName.trim(),
    newBankName: input.newBankName.trim(),
    newAccountNumber: input.newAccountNumber,
    newRoutingNumber: input.newRoutingNumber,
    newSwiftCode: input.newSwiftCode,
    newCurrency: input.newCurrency.toUpperCase(),
    providerName: input.providerName,
    status: "pending",
    verifiedBy: null,
    verifiedAtEpochMs: null,
    verificationNote: null,
    newBankAccountId: null,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
  };

  options.store.insert(request);
  return { status: "submitted", request };
}

/** The result of verifying a bank change request. */
export type VerifyBankChangeResult =
  | { status: "approved"; request: BankChangeRequest; newAccount: PayoutBankAccount }
  | { status: "rejected"; request: BankChangeRequest }
  | { status: "failed"; reason: string };

/** Verify a bank change request: approve creates the new account, reject keeps the previous bank. */
export function verifyBankChangeRequest(
  requestId: string,
  options: {
    readonly decision: "approve" | "reject";
    readonly verifierId: string;
    readonly note: string | null;
    readonly store: BankChangeRequestStore;
    readonly bankAccountStore: PayoutBankAccountStore;
    readonly linkProviderBank: ProviderBankLinkingFn;
    readonly occurredAtEpochMs: number;
  },
): VerifyBankChangeResult {
  // 1. Check that the request exists and is pending.
  const request = options.store.findById(requestId);
  if (request === null) {
    return { status: "failed", reason: "the bank change request does not exist" };
  }
  if (request.status !== "pending") {
    return { status: "failed", reason: "the bank change request is not pending" };
  }

  const now = options.occurredAtEpochMs;

  // 2. Reject: mark the request rejected, do not create a new account.
  if (options.decision === "reject") {
    const rejected: BankChangeRequest = {
      ...request,
      status: "rejected",
      verifiedBy: options.verifierId,
      verifiedAtEpochMs: now,
      verificationNote: options.note,
      updatedAtEpochMs: now,
    };
    options.store.insert(rejected);
    return { status: "rejected", request: rejected };
  }

  // 3. Approve: create the new bank account with the provider.
  const addResult = addPayoutBankAccount(
    {
      companyId: request.companyId,
      accountHolderName: request.newAccountHolderName,
      bankName: request.newBankName,
      accountNumber: request.newAccountNumber,
      routingNumber: request.newRoutingNumber,
      swiftCode: request.newSwiftCode,
      currency: request.newCurrency,
      providerName: request.providerName,
    },
    {
      store: options.bankAccountStore,
      linkProviderBank: options.linkProviderBank,
      occurredAtEpochMs: now,
    },
  );

  if (addResult.status === "failed") {
    return { status: "failed", reason: addResult.reason };
  }

  // 4. Mark the request approved and carry the new account id.
  const approved: BankChangeRequest = {
    ...request,
    status: "approved",
    verifiedBy: options.verifierId,
    verifiedAtEpochMs: now,
    verificationNote: options.note,
    newBankAccountId: addResult.account.id,
    updatedAtEpochMs: now,
  };
  options.store.insert(approved);

  return { status: "approved", request: approved, newAccount: addResult.account };
}
