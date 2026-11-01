// path: lib/jobs/worker.ts
import { appConfig } from "../../config/app.ts";
import { isAppError } from "../errors/app-error.ts";
import { ERROR_CODES, INTERNAL_ERROR_CODE, isErrorCode } from "../errors/codes.ts";
import { runWithRequestContext } from "../logger/context.ts";
import { logger as defaultLogger, type Logger } from "../logger/logger.ts";
import type { JobQueue } from "./queue.ts";
import type { JobRegistry } from "./registry.ts";
import type { JobRecord, RegisteredJob } from "./types.ts";

/**
 * The job worker.
 *
 * One attempt at a time, per call: reserve a job, validate its payload, run the handler under a
 * timeout inside the job's request context, then record the outcome. The worker never throws at
 * the caller: a handler failure is data the queue stores, not an exception that kills a loop.
 *
 * Failure classification comes from the STEP 008 catalog. A `VALIDATION_FAILED` or
 * `PERMISSION_DENIED` is not worth a retry, so it dies immediately; an unknown failure is retried
 * with exponential backoff until `maxAttempts`. A handler that outlives its timeout is aborted
 * through the `AbortSignal` it received and recorded as `TIMEOUT`, so one stuck provider call
 * cannot hold a slot for ever.
 *
 * FEATURE_LIST section 32 asks for stalled jobs to raise an alert, so every claim takes a lease
 * and every entry point first returns jobs whose lease expired to the queue.
 */

class JobTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Job "${name}" exceeded its ${timeoutMs} ms timeout.`);
    this.name = "JobTimeoutError";
  }
}

export interface JobWorkerOptions {
  readonly queue: JobQueue;
  readonly registry: JobRegistry;
  readonly logger?: Logger;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  /** Injected clock, used by the gate. */
  readonly now?: () => number;
}

export interface WorkerRunResult {
  readonly ran: boolean;
  readonly status: "completed" | "retrying" | "failed" | "none";
  readonly jobId: string | null;
}

const defaultLeaseSlackMs = 30_000;

export class JobWorker {
  private readonly queue: JobQueue;
  private readonly registry: JobRegistry;
  private readonly log: Logger;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;

  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = true;
  private processed = 0;

  constructor(options: JobWorkerOptions) {
    this.queue = options.queue;
    this.registry = options.registry;
    this.log = options.logger ?? defaultLogger;
    this.concurrency = Math.max(1, options.concurrency ?? appConfig.jobs.workerConcurrency);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1000);
    this.leaseDurationMs = Math.max(
      1,
      options.leaseDurationMs ??
        appConfig.jobs.jobTimeoutSeconds * 1000 + defaultLeaseSlackMs,
    );
    this.now = options.now ?? (() => Date.now());
  }

  get processedCount(): number {
    return this.processed;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Claims and runs one job. Resolves `ran: false` when the queue is empty. */
  async runOnce(): Promise<WorkerRunResult> {
    await this.queue.releaseExpiredLeases(this.now());

    const record = await this.queue.reserve({
      leaseDurationMs: this.leaseDurationMs,
      now: this.now(),
    });

    if (record === null) {
      return { ran: false, status: "none", jobId: null };
    }

    const status = await this.execute(record);
    this.processed += 1;

    return { ran: true, status, jobId: record.id };
  }

  /** Runs until the queue is empty or the budget is spent. Used by a cron entry point and the gate. */
  async drain(maxJobs: number = 100): Promise<{ processed: number; completed: number; retrying: number; failed: number }> {
    const totals = { processed: 0, completed: 0, retrying: 0, failed: 0 };

    while (totals.processed < maxJobs) {
      const result = await this.runOnce();

      if (!result.ran) {
        break;
      }

      totals.processed += 1;

      if (result.status === "completed") {
        totals.completed += 1;
      } else if (result.status === "retrying") {
        totals.retrying += 1;
      } else if (result.status === "failed") {
        totals.failed += 1;
      }
    }

    return totals;
  }

  /**
   * Starts the polling loop. A deployment STEP decides when this is called: nothing starts a
   * background loop at import time, because that is how a serverless platform ends up with two
   * workers and an invoice.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    void this.tick();
  }

  /** Stops polling and waits for the claims already running to finish. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await Promise.allSettled([...this.inFlight]);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) {
      return;
    }

    this.ticking = true;

    try {
      const freeSlots = this.concurrency - this.inFlight.size;

      for (let slot = 0; slot < freeSlots; slot += 1) {
        const task = this.runOnce().then(
          () => undefined,
          () => undefined,
        );

        this.inFlight.add(task);
        void task.finally(() => {
          this.inFlight.delete(task);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async execute(record: JobRecord): Promise<"completed" | "retrying" | "failed"> {
    const startedAtEpochMs = this.now();

    return runWithRequestContext({ requestId: record.traceId }, async () => {
      const log = this.log.child({
        jobId: record.id,
        jobName: record.name,
        attempt: record.attempt,
      });

      // A record whose name was never registered cannot run and never will: it is a deployment
      // error, not a transport error, so it is settled instead of being retried forever.
      if (!this.registry.has(record.name)) {
        log.error("job is not registered", {});
        await this.queue.fail(record.id, {
          code: INTERNAL_ERROR_CODE,
          retryable: false,
          now: this.now(),
        });

        return "failed";
      }

      const job = this.registry.get(record.name);
      let payload: unknown;

      try {
        payload = job.parsePayload(record.payload);
      } catch (error) {
        log.error("job payload rejected", { error });
        await this.queue.fail(record.id, {
          code: "VALIDATION_FAILED",
          retryable: false,
          now: this.now(),
        });

        return "failed";
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, job.timeoutMs);

      log.info("job started", { maxAttempts: record.maxAttempts });

      try {
        await this.runWithTimeout(job, record, payload, controller);

        await this.queue.complete(record.id, this.now());
        log.info("job completed", { durationMs: Math.max(0, this.now() - startedAtEpochMs) });

        return "completed";
      } catch (error) {
        return this.recordFailure(record, error, controller.signal.aborted, log);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private async runWithTimeout(
    job: RegisteredJob,
    record: JobRecord,
    payload: unknown,
    controller: AbortController,
  ): Promise<void> {
    const runPromise = job.run({
      jobId: record.id,
      name: record.name,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      traceId: record.traceId,
      payload,
      signal: controller.signal,
    });

    // If the timeout wins the race the handler may still reject later; that rejection is the
    // handler's business and must not surface as an unhandled rejection.
    void runPromise.catch(() => undefined);

    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(new JobTimeoutError(record.name, job.timeoutMs));
        },
        { once: true },
      );
    });

    await Promise.race([runPromise, abortPromise]);
  }

  private async recordFailure(
    record: JobRecord,
    error: unknown,
    timedOut: boolean,
    log: Logger,
  ): Promise<"retrying" | "failed"> {
    const failure = classifyFailure(error, timedOut);
    const result = await this.queue.fail(record.id, {
      code: failure.code,
      retryable: failure.retryable,
      now: this.now(),
    });

    if (result.status === "retrying") {
      log.warn("job failed, retry scheduled", {
        code: failure.code,
        maxAttempts: record.maxAttempts,
        delayMs:
          result.availableAtEpochMs === null
            ? 0
            : Math.max(0, result.availableAtEpochMs - this.now()),
      });

      return "retrying";
    }

    log.error("job failed permanently", {
      code: failure.code,
      maxAttempts: record.maxAttempts,
      error,
    });

    return "failed";
  }
}

/**
 * Maps a thrown value to a catalog code and the catalog's retry flag.
 *
 * `timedOut` wins over the thrown value: a handler that swallowed the abort still failed because
 * time ran out, and `TIMEOUT` is the code an operator expects to see.
 */
export function classifyFailure(
  error: unknown,
  timedOut: boolean,
): { code: string; retryable: boolean } {
  if (timedOut) {
    return { code: "TIMEOUT", retryable: ERROR_CODES.TIMEOUT.retryable };
  }

  if (isAppError(error) && isErrorCode(error.code)) {
    return { code: error.code, retryable: ERROR_CODES[error.code].retryable };
  }

  return { code: INTERNAL_ERROR_CODE, retryable: ERROR_CODES.INTERNAL_ERROR.retryable };
}
