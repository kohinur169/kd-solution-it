// path: lib/jobs/scheduler.ts
import { createRequestId } from "../logger/context.ts";
import { logger as defaultLogger, type Logger } from "../logger/logger.ts";
import type { JobQueue } from "./queue.ts";
import type { JobRegistry } from "./registry.ts";
import { JobNotRegisteredError } from "./types.ts";

/**
 * The job scheduler.
 *
 * A schedule is a name, a payload and an interval. The clock divides wall time into slots, and a
 * slot runs at most once: the slot index is part of the idempotency key, so a scheduler that ticks
 * twice, or two instances that tick at the same moment, still enqueue one job per slot.
 *
 * There is no cron parser on purpose. "Every N minutes, offset by M seconds" covers the recurring
 * work in FEATURE_LIST section 27 -- invoice runs, reconciliation, cleanups and it is a rule a
 * reader can verify without a library. A calendar schedule, if it is ever needed, arrives with the
 * deployment STEP that owns the clock, not with a hidden dependency here.
 *
 * The scheduler never starts itself. `tick()` is called by whatever owns time in the deployment,
 * which keeps a serverless invocation from spawning a loop that outlives the request.
 */

const minimumIntervalMs = 1000;

export interface ScheduleDefinition {
  readonly name: string;
  /** Validated by the job's own schema when the job is enqueued. */
  readonly payload: unknown;
  /** How often the schedule fires. At least one second. */
  readonly everyMs: number;
  /** Offset into the slot, so two hourly jobs do not start at the same instant. */
  readonly delayMs?: number;
  readonly maxAttempts?: number;
}

/** One registered schedule and what the last tick did with it. */
export interface ScheduleState {
  readonly name: string;
  readonly everyMs: number;
  readonly delayMs: number;
  readonly lastSlot: number | null;
  readonly lastEnqueuedAtEpochMs: number | null;
}

export interface SchedulerTickResult {
  readonly enqueued: number;
  readonly skipped: number;
  readonly atEpochMs: number;
}

/** Two schedules with one name would make the interval that runs depend on registration order. */
export class ScheduleAlreadyRegisteredError extends Error {
  constructor(name: string) {
    super(`A schedule already exists under the name "${name}".`);
    this.name = "ScheduleAlreadyRegisteredError";
  }
}

export interface JobSchedulerOptions {
  readonly queue: JobQueue;
  /** When given, a schedule can only name a job that exists. */
  readonly registry?: JobRegistry;
  readonly logger?: Logger;
  readonly now?: () => number;
}

interface MutableSchedule {
  readonly definition: ScheduleDefinition;
  lastSlot: number | null;
  lastEnqueuedAtEpochMs: number | null;
}

export class JobScheduler {
  private readonly queue: JobQueue;
  private readonly registry: JobRegistry | undefined;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly entries = new Map<string, MutableSchedule>();
  private lastTickEpochMs: number | null = null;

  constructor(options: JobSchedulerOptions) {
    this.queue = options.queue;
    this.registry = options.registry;
    this.log = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  get lastTickAtEpochMs(): number | null {
    return this.lastTickEpochMs;
  }

  list(): readonly ScheduleState[] {
    return [...this.entries.values()].map((schedule) => ({
      name: schedule.definition.name,
      everyMs: schedule.definition.everyMs,
      delayMs: schedule.definition.delayMs ?? 0,
      lastSlot: schedule.lastSlot,
      lastEnqueuedAtEpochMs: schedule.lastEnqueuedAtEpochMs,
    }));
  }

  /**
   * Registers a schedule.
   *
   * An interval below a second would let one job name consume a worker pool by itself, so it is a
   * programming error rather than a configuration choice. A schedule for an unregistered job is
   * rejected here, where the stack points at the mistake, instead of enqueuing rows that can never
   * run.
   */
  register(definition: ScheduleDefinition): void {
    if (!Number.isInteger(definition.everyMs) || definition.everyMs < minimumIntervalMs) {
      throw new RangeError(
        `Schedule "${definition.name}" needs an integer interval of at least ${minimumIntervalMs} ms.`,
      );
    }

    const delayMs = definition.delayMs ?? 0;

    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs >= definition.everyMs) {
      throw new RangeError(
        `Schedule "${definition.name}" needs a delay between 0 and its interval.`,
      );
    }

    if (this.entries.has(definition.name)) {
      throw new ScheduleAlreadyRegisteredError(definition.name);
    }

    if (this.registry !== undefined && !this.registry.has(definition.name)) {
      throw new JobNotRegisteredError(definition.name);
    }

    this.entries.set(definition.name, {
      definition,
      lastSlot: null,
      lastEnqueuedAtEpochMs: null,
    });
  }

  /** Enqueues one job per schedule whose current slot has not run yet. */
  async tick(): Promise<SchedulerTickResult> {
    const now = this.now();
    let enqueued = 0;
    let skipped = 0;

    for (const schedule of this.entries.values()) {
      const { definition } = schedule;
      const slot = Math.floor(now / definition.everyMs);

      if (schedule.lastSlot !== null && slot <= schedule.lastSlot) {
        skipped += 1;
        continue;
      }

      if (this.registry !== undefined && !this.registry.has(definition.name)) {
        skipped += 1;
        this.log.warn("schedule skipped, job is not registered", { jobName: definition.name });
        continue;
      }

      const slotStartEpochMs = slot * definition.everyMs;
      const eligibleAtEpochMs = slotStartEpochMs + (definition.delayMs ?? 0);
      const registered = this.registry?.get(definition.name);
      const maxAttempts = definition.maxAttempts ?? registered?.maxAttempts;

      await this.queue.enqueue(definition.name, definition.payload, {
        idempotencyKey: `schedule:${definition.name}:${slot}`,
        delayMs: Math.max(0, eligibleAtEpochMs - now),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        traceId: createRequestId(),
        now,
      });

      schedule.lastSlot = slot;
      schedule.lastEnqueuedAtEpochMs = now;
      enqueued += 1;
      this.log.info("schedule enqueued", { jobName: definition.name, slot });
    }

    this.lastTickEpochMs = now;

    return { enqueued, skipped, atEpochMs: now };
  }
}
