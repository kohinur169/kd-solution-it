// path: lib/payments/adapters/nmi.ts

/**
 * The NMI adapter: the documentation verification and sandbox notes recording for the NMI provider.
 *
 * ## What this file is
 *
 * Section 17 of the feature list says "card data is collected only through Collect.js hosted fields
 * (https://secure.nmi.com/token/Collect.js), which returns a payment token to the browser." The NMI
 * adapter is the first of five provider adapters (STEPs 147-169). Before any code is written against
 * NMI's API, the documentation is verified and sandbox notes are recorded: what was reviewed, what was
 * tested in the sandbox, and what the result was.
 *
 * This file is the core service for that verification. It records:
 *
 * - **Documentation checks**: each topic reviewed (NMI API docs, Collect.js rules, gateway integration,
 *   token-based payment flow) with the URL, whether it was verified, and any notes.
 * - **Sandbox notes**: each test run in the NMI sandbox (token generation, charge, refund, capture) with
 *   the result (pass, fail, or not tested) and details.
 * - **Overall status**: calculated from the checks and notes — "verified" when all checks pass and all
 *   tests pass, "partial" when some pass, "not_verified" when none pass.
 *
 * ## What this file is not
 *
 * It is not the NMI API client itself (a later STEP in 147-169 builds that). It is not the
 * `lib/gateways/registry.ts` provider declaration (that already exists from the gateways system). It is
 * not the API route or UI for viewing verification records. This file is the core service: the record,
 * the recording function, and the store.
 */

import { randomUUID } from "node:crypto";

/** A single documentation check: one topic reviewed from the NMI documentation. */
export interface NmiDocumentationCheck {
  readonly topic: string;
  readonly url: string;
  readonly verified: boolean;
  readonly notes: string | null;
}

/** A single sandbox note: one test run in the NMI sandbox. */
export interface NmiSandboxNote {
  readonly test: string;
  readonly result: "pass" | "fail" | "not_tested";
  readonly details: string | null;
}

/** The overall verification status calculated from the checks and notes. */
export type NmiOverallStatus = "verified" | "partial" | "not_verified";

/** A NMI verification record: the documentation checks, sandbox notes, and overall status. */
export interface NmiVerificationRecord {
  readonly id: string;
  readonly providerName: string;
  readonly documentationChecks: NmiDocumentationCheck[];
  readonly sandboxNotes: NmiSandboxNote[];
  readonly overallStatus: NmiOverallStatus;
  readonly verifiedAtEpochMs: number;
  readonly verifiedBy: string;
}

/** What the store reads and writes: the NMI verification records. The store is the caller's. */
export interface NmiVerificationStore {
  /** Store a verification record, replacing any record with the same id. */
  insert(record: NmiVerificationRecord): void;
  /** The record an id already holds, or null when the record is new. */
  findById(id: string): NmiVerificationRecord | null;
  /** Every record for a provider. */
  findByProvider(providerName: string): NmiVerificationRecord[];
  /** The most recent record for a provider, or null when none exists. */
  findLatest(providerName: string): NmiVerificationRecord | null;
}

/** The in-memory store: a reference implementation that keys on record id. */
export class InMemoryNmiVerificationStore implements NmiVerificationStore {
  private readonly records = new Map<string, NmiVerificationRecord>();

  insert(record: NmiVerificationRecord): void {
    this.records.set(record.id, record);
  }

  findById(id: string): NmiVerificationRecord | null {
    return this.records.get(id) ?? null;
  }

  findByProvider(providerName: string): NmiVerificationRecord[] {
    return [...this.records.values()].filter((record) => record.providerName === providerName);
  }

  findLatest(providerName: string): NmiVerificationRecord | null {
    const records = this.findByProvider(providerName);
    records.sort((a, b) => b.verifiedAtEpochMs - a.verifiedAtEpochMs);
    return records[0] ?? null;
  }
}

/** The input to recording a NMI verification. */
export interface RecordNmiVerificationInput {
  readonly documentationChecks: NmiDocumentationCheck[];
  readonly sandboxNotes: NmiSandboxNote[];
  readonly verifiedBy: string;
}

/** The result of recording a NMI verification. */
export type RecordNmiVerificationResult =
  | { status: "recorded"; record: NmiVerificationRecord }
  | { status: "failed"; reason: string };

/** Calculate the overall status from the documentation checks and sandbox notes. */
function calculateOverallStatus(
  documentationChecks: NmiDocumentationCheck[],
  sandboxNotes: NmiSandboxNote[],
): NmiOverallStatus {
  const allChecksVerified = documentationChecks.every((check) => check.verified);
  const allTestsPass = sandboxNotes.every((note) => note.result === "pass");

  if (allChecksVerified && allTestsPass) {
    return "verified";
  }

  const anyVerified = documentationChecks.some((check) => check.verified);
  const anyPass = sandboxNotes.some((note) => note.result === "pass");

  if (anyVerified || anyPass) {
    return "partial";
  }

  return "not_verified";
}

/** Record a NMI verification: validate, calculate the overall status, store the record. */
export function recordNmiVerification(
  input: RecordNmiVerificationInput,
  options: {
    readonly store: NmiVerificationStore;
    readonly occurredAtEpochMs: number;
  },
): RecordNmiVerificationResult {
  // 1. Validate.
  if (input.documentationChecks.length === 0) {
    return { status: "failed", reason: "at least one documentation check is required" };
  }
  if (input.verifiedBy.trim().length === 0) {
    return { status: "failed", reason: "the verifiedBy field must not be empty" };
  }
  for (const check of input.documentationChecks) {
    if (check.topic.trim().length === 0) {
      return { status: "failed", reason: "a documentation check must have a topic" };
    }
    if (check.url.trim().length === 0) {
      return { status: "failed", reason: `the documentation check "${check.topic}" must have a url` };
    }
  }
  for (const note of input.sandboxNotes) {
    if (note.test.trim().length === 0) {
      return { status: "failed", reason: "a sandbox note must have a test name" };
    }
  }

  // 2. Calculate the overall status.
  const overallStatus = calculateOverallStatus(input.documentationChecks, input.sandboxNotes);

  // 3. Create and store the record.
  const record: NmiVerificationRecord = {
    id: randomUUID(),
    providerName: "nmi",
    documentationChecks: input.documentationChecks,
    sandboxNotes: input.sandboxNotes,
    overallStatus,
    verifiedAtEpochMs: options.occurredAtEpochMs,
    verifiedBy: input.verifiedBy,
  };

  options.store.insert(record);
  return { status: "recorded", record };
}
