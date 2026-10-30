// path: lib/jobs/queue.ts
import { randomUUID } from "node:crypto";
import { appConfig } from "../../config/app.ts";
import { resolveRequestId } from "../logger/context.ts";
import type {
  EnqueueOptions,
  EnqueueResult,
  FailureOptions,
  FailureResult,
  JobRecord,
  JobStatus,
  QueueSnapshot,
  ReserveOptions,
} from "./types.ts";

/**
 * The queue port and its in-process implementation.
 *
 * FEATURE_LIST section 27 puts ten families of work outside the request path, and section 32
 * requires a stalled job to raise an alert. Both needs are satisfied by the same four
 * operations: enqueue, reserve, complete and fail. The port is asynchronous because the durable
 * implementation will be SQL, and STEP 012 owns the table that stores these records.
 *
 * The in-process store below is the development and gate store. It is durable for the life of one
 * process and no longer, which is why its health snapshot says `memory` and why the runtime in
 * `runtime.ts` never starts a loop by itself.
 *
 * Guarantees this implementation does provide, because the worker depends on them:
 *   - one claim at a time: a reserved job leaves the `pending` and `retrying` pools;
 *   - a lease, so a crashed worker does not hold a job forever;
 *   - idempotency keys, so a retried webhook or a double submitted form stays one job;
 *   - a bounded retry policy with exponential backoff from configuration;
 *   - a bounded memory footprint, by dropping the oldest finished records beyond a cap.
 */

export const IN_MEMORY_JOB_STORE = "memory";

/** How many finished records the development store keeps before dropping the oldest. */
const retainedFinishedJobs = 1000;

const eligibleStatuses: ReadonlySet<JobStatus> = new Set(["pending", "retrying"]);

/** The queue operations the worker, the scheduler and the health route rely on. */
export interface JobQueue {
  readonly store: string;
  enqueue(name: string, payload: unknown, options?: EnqueueOptions): Promise<EnqueueResult>;
  /** Claims the oldest eligible job, or returns null when there is nothing to do. */
  reserve(options: ReserveOptions): Promise<JobRecord | null>;
  complete(jobId: string, now?: number): Promise<void>;
  fail(jobId: string, options: FailureOptions): Promise<FailureResult>;
  /** Returns jobs whose lease expired to the queue, and reports how many were recovered. */
  releaseExpiredLeases(now?: number): Promise<number>;
  snapshot(now?: number): Promise<QueueSnapshot>;
}

/** Exponential backoff with a ceiling, both from configuration. */
export function retryDelayMs(attempt: number): number {
  const baseMs = appConfig.jobs.retryBaseDelaySeconds * 1000;
  const ceilingMs = appConfig.jobs.retryMaxDelaySeconds * 1000;
  const exponent = Math.max(0, attempt - 1);

  return Math.min(ceilingMs, baseMs * 2 ** Math.min(exponent, 16));
}

function isEligible(job: JobRecord, now: number): boolean {
  return eligibleStatuses.has(job.status) && job.availableAtEpochMs <= now;
}

function isFinished(job: JobRecord): boolean {
  return job.status === "completed" || job.status === "failed";
}

export class InMemoryJobQueue implements JobQueue {
  readonly store = IN_MEMORY_JOB_STORE;

  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotencyKeys = new Map<string, string>();

  async enqueue(name: string, payload: unknown, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const now = options.now ?? Date.now();
    const idempotencyKey = options.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existingId = this.idempotencyKeys.get(idempotencyKey);
      const existing = existingId === undefined ? undefined : this.jobs.get(existingId);

      if (existing !== undefined) {
        return { job: existing, deduplicated: true };
      }
    }

    const job: JobRecord = {
      id: randomUUID(),
      name,
      payload,
      status: "pending",
      attempt: 0,
      maxAttempts: options.maxAttempts ?? appConfig.jobs.defaultMaxAttempts,
      idempotencyKey,
      traceId: resolveRequestId(options.traceId),
      availableAtEpochMs: now + Math.max(0, options.delayMs ?? 0),
      leaseExpiresAtEpochMs: null,
      lastErrorCode: null,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
    };

    this.jobs.set(job.id, job);

    if (idempotencyKey !== null) {
      this.idempotencyKeys.set(idempotencyKey, job.id);
    }

    this.pruneFinishedJobs();

    return { job, deduplicated: false };
  }

  async reserve(options: ReserveOptions): Promise<JobRecord | null> {
    const now = options.now ?? Date.now();
    const candidate = [...this.jobs.values()]
      .filter((job) => isEligible(job, now))
      .sort(
        (left, right) =>
          left.availableAtEpochMs - right.availableAtEpochMs ||
          left.createdAtEpochMs - right.createdAtEpochMs,
      )[0];

    if (candidate === undefined) {
      return null;
    }

    const claimed: JobRecord = {
      ...candidate,
      status: "running",
      attempt: candidate.attempt + 1,
      leaseExpiresAtEpochMs: now + options.leaseDurationMs,
      updatedAtEpochMs: now,
    };

    this.jobs.set(claimed.id, claimed);

    return claimed;
  }

  async complete(jobId: string, now: number = Date.now()): Promise<void> {
    const job = this.jobs.get(jobId);

    if (job === undefined) {
      return;
    }

    this.jobs.set(jobId, {
      ...job,
      status: "completed",
      leaseExpiresAtEpochMs: null,
      updatedAtEpochMs: now,
    });
  }

  async fail(jobId: string, options: FailureOptions): Promise<FailureResult> {
    const job = this.jobs.get(jobId);

    if (job === undefined) {
      throw new Error(`Cannot fail the job "${jobId}": it is not in this queue.`);
    }

    const now = options.now ?? Date.now();
    const canRetry = options.retryable && job.attempt < job.maxAttempts;

    if (canRetry) {
      const availableAtEpochMs = now + retryDelayMs(job.attempt);

      this.jobs.set(jobId, {
        ...job,
        status: "retrying",
        leaseExpiresAtEpochMs: null,
        lastErrorCode: options.code,
        availableAtEpochMs,
        updatedAtEpochMs: now,
      });

      return { status: "retrying", attempt: job.attempt, availableAtEpochMs };
    }

    this.jobs.set(jobId, {
      ...job,
      status: "failed",
      leaseExpiresAtEpochMs: null,
      lastErrorCode: options.code,
      updatedAtEpochMs: now,
    });

    return { status: "failed", attempt: job.attempt, availableAtEpochMs: null };
  }

  async releaseExpiredLeases(now: number = Date.now()): Promise<number> {
    let recovered = 0;

    for (const job of this.jobs.values()) {
      if (job.status !== "running" || job.leaseExpiresAtEpochMs === null) {
        continue;
      }

      if (job.leaseExpiresAtEpochMs > now) {
        continue;
      }

      recovered += 1;

      if (job.attempt >= job.maxAttempts) {
        this.jobs.set(job.id, {
          ...job,
          status: "failed",
          leaseExpiresAtEpochMs: null,
          lastErrorCode: "LEASE_EXPIRED",
          updatedAtEpochMs: now,
        });
        continue;
      }

      this.jobs.set(job.id, {
        ...job,
        status: "retrying",
        leaseExpiresAtEpochMs: null,
        lastErrorCode: "LEASE_EXPIRED",
        availableAtEpochMs: now,
        updatedAtEpochMs: now,
      });
    }

    return recovered;
  }

  async snapshot(now: number = Date.now()): Promise<QueueSnapshot> {
    const counts: Record<JobStatus, number> = {
      pending: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
    };

    let oldestWaitingCreatedAt: number | null = null;
    let stalled = 0;

    for (const job of this.jobs.values()) {
      counts[job.status] += 1;

      if (isEligible(job, now)) {
        oldestWaitingCreatedAt =
          oldestWaitingCreatedAt === null
            ? job.createdAtEpochMs
            : Math.min(oldestWaitingCreatedAt, job.createdAtEpochMs);
      }

      if (
        job.status === "running" &&
        job.leaseExpiresAtEpochMs !== null &&
        job.leaseExpiresAtEpochMs <= now
      ) {
        stalled += 1;
      }
    }

    return {
      pending: counts.pending,
      running: counts.running,
      retrying: counts.retrying,
      completed: counts.completed,
      failed: counts.failed,
      total: this.jobs.size,
      oldestPendingAgeMs:
        oldestWaitingCreatedAt === null ? 0 : Math.max(0, now - oldestWaitingCreatedAt),
      stalled,
    };
  }

  /** Drops the oldest finished records so a development process cannot grow without a bound. */
  private pruneFinishedJobs(): void {
    const finished = [...this.jobs.values()].filter(isFinished);

    if (finished.length <= retainedFinishedJobs) {
      return;
    }

    finished
      .sort((left, right) => left.updatedAtEpochMs - right.updatedAtEpochMs)
      .slice(0, finished.length - retainedFinishedJobs)
      .forEach((job) => {
        this.jobs.delete(job.id);

        if (job.idempotencyKey !== null) {
          this.idempotencyKeys.delete(job.idempotencyKey);
        }
      });
  }
}

/** The development and gate store. Step 012 adds the durable one behind the same port. */
export function createInMemoryJobQueue(): JobQueue {
  return new InMemoryJobQueue();
}
