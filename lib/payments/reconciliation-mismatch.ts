// path: lib/payments/reconciliation-mismatch.ts

/**
 * The payment core's reconciliation mismatch queue: the service that holds mismatches from the
 * reconciliation import (STEP 145) and tracks their resolution within the 3-day window.
 *
 * ## What the queue is
 *
 * Section 11 says "a mismatch must be resolved by the responsible team within 3 days." When the
 * reconciliation import (STEP 145) finds a mismatch — a processor-only entry, a system-only record,
 * or an amount mismatch — it does not disappear. The mismatch goes into a queue. The queue tracks
 * every mismatch, who resolved it, when, and whether the 3-day deadline was met.
 *
 * A mismatch starts as "open". It is "resolved" when the responsible team acts on it. If the 3-day
 * deadline passes while it is still open, it is "overdue". The queue is what the office uses to see
 * what needs attention and what has been handled.
 *
 * ## What this file is not
 *
 * It is not the reconciliation import that produces the mismatches (STEP 145 owns that — this file
 * receives them). It is not the audit log itself (a later STEP owns that — this file records the
 * resolution fields that the audit log would read). It is not the API route or UI for viewing the
 * queue. This file is the core service: the queue, the add, the resolve, and the overdue check.
 */

import { randomUUID } from "node:crypto";
import type { ReconciliationMatchStatus } from "./reconciliation-import.ts";

/** The resolution deadline: 3 days in milliseconds. */
export const MISMATCH_RESOLUTION_DEADLINE_MS = 3 * 24 * 60 * 60 * 1000;

/** The lifecycle of a mismatch. */
export type MismatchStatus = "open" | "resolved" | "overdue";

/** A reconciliation mismatch: one unresolved difference between a processor report and system records. */
export interface ReconciliationMismatch {
  readonly id: string;
  readonly companyId: string;
  readonly providerName: string;
  readonly providerTransactionId: string;
  readonly type: ReconciliationMatchStatus;
  readonly processorAmountMinor: bigint;
  readonly systemAmountMinor: bigint | null;
  readonly status: MismatchStatus;
  readonly createdAtEpochMs: number;
  readonly resolutionDeadlineEpochMs: number;
  readonly resolvedAtEpochMs: number | null;
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
}

/** What the store reads and writes: the mismatch queue. The store is the caller's. */
export interface MismatchStore {
  /** Store a mismatch, replacing any mismatch with the same id. */
  insert(mismatch: ReconciliationMismatch): void;
  /** The mismatch an id already holds, or null when the mismatch is new. */
  findById(id: string): ReconciliationMismatch | null;
  /** Every mismatch a company has, open, overdue, and resolved. */
  findByCompany(companyId: string): ReconciliationMismatch[];
  /** Every open mismatch a company has — the ones the office still needs to resolve. */
  findOpenByCompany(companyId: string): ReconciliationMismatch[];
  /** Every open mismatch that is overdue at the given time. */
  findOverdue(nowEpochMs: number): ReconciliationMismatch[];
  /** Every open mismatch that is still within the 3-day window at the given time. */
  findOpen(nowEpochMs: number): ReconciliationMismatch[];
}

/** The in-memory store: a reference implementation that keys on mismatch id. */
export class InMemoryMismatchStore implements MismatchStore {
  private readonly mismatches = new Map<string, ReconciliationMismatch>();

  insert(mismatch: ReconciliationMismatch): void {
    this.mismatches.set(mismatch.id, mismatch);
  }

  findById(id: string): ReconciliationMismatch | null {
    return this.mismatches.get(id) ?? null;
  }

  findByCompany(companyId: string): ReconciliationMismatch[] {
    return [...this.mismatches.values()].filter((mismatch) => mismatch.companyId === companyId);
  }

  findOpenByCompany(companyId: string): ReconciliationMismatch[] {
    return this.findByCompany(companyId).filter((mismatch) => mismatch.status === "open");
  }

  findOverdue(nowEpochMs: number): ReconciliationMismatch[] {
    return [...this.mismatches.values()].filter(
      (mismatch) =>
        (mismatch.status === "open" || mismatch.status === "overdue") &&
        nowEpochMs >= mismatch.resolutionDeadlineEpochMs,
    );
  }

  findOpen(nowEpochMs: number): ReconciliationMismatch[] {
    return [...this.mismatches.values()].filter(
      (mismatch) => mismatch.status === "open" && nowEpochMs < mismatch.resolutionDeadlineEpochMs,
    );
  }
}

/** The result of adding a mismatch to the queue. */
export type AddMismatchResult =
  | { status: "added"; mismatch: ReconciliationMismatch }
  | { status: "failed"; reason: string };

/** The input to adding a mismatch. */
export interface AddMismatchInput {
  readonly companyId: string;
  readonly providerName: string;
  readonly providerTransactionId: string;
  readonly type: ReconciliationMatchStatus;
  readonly processorAmountMinor: bigint;
  readonly systemAmountMinor: bigint | null;
}

/** Add a mismatch to the queue: validate, check for duplicates, create an open mismatch. */
export function addMismatch(
  input: AddMismatchInput,
  options: {
    readonly store: MismatchStore;
    readonly occurredAtEpochMs: number;
  },
): AddMismatchResult {
  // 1. Validate.
  if (input.companyId.trim().length === 0) {
    return { status: "failed", reason: "the company id must not be empty" };
  }
  if (input.providerName.trim().length === 0) {
    return { status: "failed", reason: "the provider name must not be empty" };
  }
  if (input.providerTransactionId.trim().length === 0) {
    return { status: "failed", reason: "the provider transaction id must not be empty" };
  }
  if (input.type === "matched") {
    return { status: "failed", reason: "a matched entry is not a mismatch" };
  }

  // 2. Check that there is no duplicate open mismatch for the same company and transaction.
  const existing = options.store.findOpenByCompany(input.companyId).find(
    (mismatch) => mismatch.providerTransactionId === input.providerTransactionId,
  );
  if (existing !== undefined) {
    return { status: "failed", reason: "a mismatch for this provider transaction id is already in the queue" };
  }

  // 3. Create the mismatch with a 3-day resolution deadline.
  const now = options.occurredAtEpochMs;
  const mismatch: ReconciliationMismatch = {
    id: randomUUID(),
    companyId: input.companyId,
    providerName: input.providerName,
    providerTransactionId: input.providerTransactionId,
    type: input.type,
    processorAmountMinor: input.processorAmountMinor,
    systemAmountMinor: input.systemAmountMinor,
    status: "open",
    createdAtEpochMs: now,
    resolutionDeadlineEpochMs: now + MISMATCH_RESOLUTION_DEADLINE_MS,
    resolvedAtEpochMs: null,
    resolutionNote: null,
    resolvedBy: null,
  };

  options.store.insert(mismatch);
  return { status: "added", mismatch };
}

/** The result of resolving a mismatch. */
export type ResolveMismatchResult =
  | { status: "resolved"; mismatch: ReconciliationMismatch }
  | { status: "failed"; reason: string };

/** Resolve a mismatch: mark it resolved with the resolver, time, and note. */
export function resolveMismatch(
  mismatchId: string,
  options: {
    readonly resolverId: string;
    readonly note: string | null;
    readonly store: MismatchStore;
    readonly nowEpochMs: number;
  },
): ResolveMismatchResult {
  // 1. Check that the mismatch exists and is open.
  const mismatch = options.store.findById(mismatchId);
  if (mismatch === null) {
    return { status: "failed", reason: "the mismatch does not exist" };
  }
  if (mismatch.status !== "open") {
    return { status: "failed", reason: "the mismatch is not open" };
  }

  // 2. Mark it resolved.
  const resolved: ReconciliationMismatch = {
    ...mismatch,
    status: "resolved",
    resolvedAtEpochMs: options.nowEpochMs,
    resolutionNote: options.note,
    resolvedBy: options.resolverId,
  };
  options.store.insert(resolved);

  return { status: "resolved", mismatch: resolved };
}

/** The result of checking whether a mismatch is overdue. */
export type CheckOverdueResult =
  | { status: "overdue"; mismatch: ReconciliationMismatch }
  | { status: "ok"; mismatch: ReconciliationMismatch }
  | { status: "failed"; reason: string };

/** Check whether a mismatch is overdue: mark it overdue when the 3-day deadline has passed. */
export function checkOverdue(
  mismatchId: string,
  nowEpochMs: number,
  options: {
    readonly store: MismatchStore;
  },
): CheckOverdueResult {
  // 1. Check that the mismatch exists and is open.
  const mismatch = options.store.findById(mismatchId);
  if (mismatch === null) {
    return { status: "failed", reason: "the mismatch does not exist" };
  }
  if (mismatch.status !== "open") {
    return { status: "failed", reason: "the mismatch is not open" };
  }

  // 2. Check if the 3-day deadline has passed.
  if (nowEpochMs >= mismatch.resolutionDeadlineEpochMs) {
    const overdue: ReconciliationMismatch = { ...mismatch, status: "overdue" };
    options.store.insert(overdue);
    return { status: "overdue", mismatch: overdue };
  }

  return { status: "ok", mismatch };
}
