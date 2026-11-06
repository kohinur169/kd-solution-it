// path: lib/payments/bank-change-cooling.ts

/**
 * The payment core's bank change cooling period enforcement: the service that pauses all payouts for a
 * company for 96 hours after a bank change request is approved by manual verification.
 *
 * ## What the cooling period is
 *
 * Section 10 says "the 96 hour cooling period starts only after manual verification passes" and "during
 * the cooling period all payouts are fully paused, including to the previous verified bank." A cooling
 * period begins when an office role approves a bank change request (STEP 140's verification). For the
 * next 96 hours, the company's payouts are fully paused — not just to the new bank account, but to every
 * bank account, including the previous verified one. After 96 hours, the cooling period expires and
 * payouts resume to the new bank account.
 *
 * The pause is the point. A bank change is a sensitive event: the merchant's payout destination is
 * changing. During the cooling period, no payout can leave the platform for that company — the office
 * has time to notice anything wrong, and the merchant has time to contest the change. The previous bank
 * is not a fallback: it is paused too.
 *
 * ## What this file is not
 *
 * It is not the bank change manual verification flow itself (STEP 140 owns that). It is not the payout
 * job that sends money (a later STEP owns that — this file is what that job checks before it pays). It
 * is not the API route or UI. This file is the core service: the cooling period record, the start
 * function, and the payout pause check.
 */

import { randomUUID } from "node:crypto";
import type { BankChangeRequestStore } from "./bank-change-verification.ts";

/** The cooling period length: 96 hours in milliseconds. */
export const COOLING_PERIOD_MS = 96 * 60 * 60 * 1000;

/** The lifecycle of a cooling period. */
export type CoolingPeriodStatus = "active" | "expired";

/** A cooling period: the 96 hour pause that follows a bank change approval. */
export interface CoolingPeriod {
  readonly id: string;
  readonly companyId: string;
  readonly requestId: string;
  readonly newBankAccountId: string;
  readonly startedAtEpochMs: number;
  readonly endsAtEpochMs: number;
  readonly status: CoolingPeriodStatus;
}

/** What the store reads and writes: the cooling periods. The store is the caller's. */
export interface CoolingPeriodStore {
  /** Store a cooling period, replacing any period with the same id. */
  insert(period: CoolingPeriod): void;
  /** The period an id already holds, or null when the period is new. */
  findById(id: string): CoolingPeriod | null;
  /** Every period a company has, active and expired. */
  findByCompany(companyId: string): CoolingPeriod[];
  /** The active period a company has: the most recent active period, or null when none is active. */
  findActiveByCompany(companyId: string): CoolingPeriod | null;
}

/** The in-memory store: a reference implementation that keys on period id. */
export class InMemoryCoolingPeriodStore implements CoolingPeriodStore {
  private readonly periods = new Map<string, CoolingPeriod>();

  insert(period: CoolingPeriod): void {
    this.periods.set(period.id, period);
  }

  findById(id: string): CoolingPeriod | null {
    return this.periods.get(id) ?? null;
  }

  findByCompany(companyId: string): CoolingPeriod[] {
    return [...this.periods.values()].filter((period) => period.companyId === companyId);
  }

  findActiveByCompany(companyId: string): CoolingPeriod | null {
    const active = this.findByCompany(companyId).filter((period) => period.status === "active");
    active.sort((a, b) => b.startedAtEpochMs - a.startedAtEpochMs);
    return active[0] ?? null;
  }
}

/** The result of starting a cooling period. */
export type StartCoolingPeriodResult =
  | { status: "started"; period: CoolingPeriod }
  | { status: "failed"; reason: string };

/** Start a cooling period: the request must be approved and no other period may be active. */
export function startCoolingPeriod(
  requestId: string,
  options: {
    readonly store: CoolingPeriodStore;
    readonly requestStore: BankChangeRequestStore;
    readonly occurredAtEpochMs: number;
  },
): StartCoolingPeriodResult {
  // 1. Check that the request exists.
  const request = options.requestStore.findById(requestId);
  if (request === null) {
    return { status: "failed", reason: "the bank change request does not exist" };
  }

  // 2. Check that the request is approved.
  if (request.status !== "approved") {
    return { status: "failed", reason: "the bank change request is not approved" };
  }

  // 3. Check that there is no already-active cooling period for the same company.
  const existing = options.store.findActiveByCompany(request.companyId);
  if (existing !== null) {
    return { status: "failed", reason: "a cooling period is already active for this company" };
  }

  // 4. Create the cooling period: 96 hours from now.
  const now = options.occurredAtEpochMs;
  const period: CoolingPeriod = {
    id: randomUUID(),
    companyId: request.companyId,
    requestId: request.id,
    newBankAccountId: request.newBankAccountId ?? "",
    startedAtEpochMs: now,
    endsAtEpochMs: now + COOLING_PERIOD_MS,
    status: "active",
  };

  options.store.insert(period);
  return { status: "started", period };
}

/** The result of checking whether payouts are paused. */
export type CheckPayoutResult =
  | { status: "allowed" }
  | { status: "paused"; reason: string; endsAtEpochMs: number }
  | { status: "failed"; reason: string };

/** Check whether payouts are paused for a company: paused during the cooling period, allowed after. */
export function checkPayoutPause(
  companyId: string,
  nowEpochMs: number,
  options: {
    readonly store: CoolingPeriodStore;
  },
): CheckPayoutResult {
  // 1. Find the active cooling period for the company.
  const period = options.store.findActiveByCompany(companyId);

  if (period === null) {
    return { status: "allowed" };
  }

  // 2. Check if the cooling period has expired.
  if (nowEpochMs >= period.endsAtEpochMs) {
    // The cooling period has expired. Update the status.
    const expired: CoolingPeriod = { ...period, status: "expired" };
    options.store.insert(expired);
    return { status: "allowed" };
  }

  // 3. The cooling period is still active. Payouts are paused.
  return {
    status: "paused",
    reason: "a bank change cooling period is active",
    endsAtEpochMs: period.endsAtEpochMs,
  };
}

/** Get the end time of the active cooling period for a company, or null when none is active. */
export function getCoolingPeriodEnd(
  companyId: string,
  nowEpochMs: number,
  options: {
    readonly store: CoolingPeriodStore;
  },
): number | null {
  const result = checkPayoutPause(companyId, nowEpochMs, options);
  if (result.status === "paused") {
    return result.endsAtEpochMs;
  }
  return null;
}
