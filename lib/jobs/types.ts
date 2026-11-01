// path: lib/jobs/types.ts
import type { ZodType } from "zod";

/**
 * The vocabulary of the background job foundation.
 *
 * FEATURE_LIST section 27 lists the work that must run outside a request: provisioning, email,
 * recurring invoices, webhooks, settlements, subscriptions, reconciliation, cleanup, audit roots
 * and compliance alerts. All of it shares the same lifecycle, so the lifecycle is defined once
 * here and every job is a name, a schema and a handler.
 *
 * The queue table that stores these records belongs to STEP 012, which is why this module defines
 * the shape rather than a migration. The port below is what a later STEP implements over SQL
 * without touching the worker, the scheduler or the health route.
 */

export type JobStatus = "pending" | "running" | "retrying" | "completed" | "failed";

/** One unit of work as the queue stores it. */
export interface JobRecord {
  readonly id: string;
  readonly name: string;
  /** Validated by the job's own schema before the handler sees it. Never logged as is. */
  readonly payload: unknown;
  readonly status: JobStatus;
  /** Attempts started so far. `0` means the job has never been claimed. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string | null;
  /** Request id shape, so a job's log lines correlate with the request that caused it. */
  readonly traceId: string;
  readonly availableAtEpochMs: number;
  /** Set while the job is claimed; an expired lease returns the job to the queue. */
  readonly leaseExpiresAtEpochMs: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export interface EnqueueOptions {
  /** A second enqueue with the same key returns the first job instead of a new one. */
  readonly idempotencyKey?: string;
  /** Delay the job is first eligible. */
  readonly delayMs?: number;
  readonly maxAttempts?: number;
  /** Trace id of the request or schedule that produced the job. */
  readonly traceId?: string;
  /** Injected clock, used by the gate. */
  readonly now?: number;
}

export interface EnqueueResult {
  readonly job: JobRecord;
  readonly deduplicated: boolean;
}

export interface ReserveOptions {
  /** Lease duration. An expired lease lets another worker pick the job up again. */
  readonly leaseDurationMs: number;
  readonly now?: number;
}

export interface FailureOptions {
  /** An error code from the STEP 008 catalog, or `INTERNAL_ERROR`. */
  readonly code: string;
  /** Comes from the catalog: a permission or validation failure is not worth a retry. */
  readonly retryable: boolean;
  readonly now?: number;
}

export interface FailureResult {
  readonly status: "retrying" | "failed";
  readonly attempt: number;
  /** When the retry becomes eligible, or null when the job is dead. */
  readonly availableAtEpochMs: number | null;
}

export interface QueueCounts {
  readonly pending: number;
  readonly running: number;
  readonly retrying: number;
  readonly completed: number;
  readonly failed: number;
}

export interface QueueSnapshot extends QueueCounts {
  readonly total: number;
  /** Age of the oldest job that is still waiting, in milliseconds. */
  readonly oldestPendingAgeMs: number;
  /** Jobs whose lease expired while they were claimed. */
  readonly stalled: number;
}

/**
 * What a handler receives.
 *
 * `signal` aborts when the attempt exceeds its timeout, so a handler that talks to a provider can
 * stop instead of holding the slot. `payload` is already validated by the job's schema.
 */
export interface JobContext<TPayload> {
  readonly jobId: string;
  readonly name: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly traceId: string;
  readonly payload: TPayload;
  readonly signal: AbortSignal;
}

/** What a caller registers once, at module load. */
export interface JobDefinition<TPayload> {
  readonly name: string;
  readonly payloadSchema: ZodType<TPayload>;
  readonly handler: (context: JobContext<TPayload>) => Promise<void>;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

/**
 * A definition after the registry has closed over it.
 *
 * The unknown payload type is the honest boundary: the registry cannot keep the generic of every
 * registration in one map, so it validates with the definition's schema and hands the parsed value
 * to the definition's own handler. The cast happens once, inside `registerJob`, immediately after
 * validation.
 */
export interface RegisteredJob {
  readonly name: string;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly parsePayload: (payload: unknown) => unknown;
  readonly run: (context: JobContext<unknown>) => Promise<void>;
}

/** A job name that was never registered is a defect, not a row that fails forever. */
export class JobNotRegisteredError extends Error {
  constructor(name: string) {
    super(`No job is registered under the name "${name}".`);
    this.name = "JobNotRegisteredError";
  }
}

/** Registering one name twice would make the handler that runs depend on import order. */
export class JobAlreadyRegisteredError extends Error {
  constructor(name: string) {
    super(`A job is already registered under the name "${name}".`);
    this.name = "JobAlreadyRegisteredError";
  }
}
