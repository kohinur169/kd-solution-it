// path: lib/jobs/registry.ts
import { appConfig } from "../../config/app.ts";
import type { JobQueue } from "./queue.ts";
import {
  JobAlreadyRegisteredError,
  JobNotRegisteredError,
  type EnqueueOptions,
  type EnqueueResult,
  type JobContext,
  type JobDefinition,
  type RegisteredJob,
} from "./types.ts";

/**
 * The job registry.
 *
 * A job is a name, a payload schema and a handler. The registry is the only place that knows
 * which names exist, so an enqueue of an unknown name fails at the call site instead of becoming
 * a row that fails on every attempt forever.
 *
 * Payload validation happens twice on purpose: once when the job is enqueued, and once before the
 * handler runs. A payload that was valid when it was written can become invalid after a deploy
 * that changed the schema, and the second parse is what turns that into a clear failure instead
 * of a handler crash on a missing field.
 *
 * Limits come from configuration (STEP 005 owns the mechanism, STEP 011 added the `jobs` section),
 * so no attempt count or timeout is hard coded in a worker.
 */

export class JobRegistry {
  private readonly jobs = new Map<string, RegisteredJob>();

  /** Registers one job. Throws when the name is already taken. */
  register<TPayload>(definition: JobDefinition<TPayload>): void {
    if (this.jobs.has(definition.name)) {
      throw new JobAlreadyRegisteredError(definition.name);
    }

    this.jobs.set(definition.name, createRegisteredJob(definition));
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  /** The registered job, or a `JobNotRegisteredError`. */
  get(name: string): RegisteredJob {
    const job = this.jobs.get(name);

    if (job === undefined) {
      throw new JobNotRegisteredError(name);
    }

    return job;
  }

  names(): readonly string[] {
    return [...this.jobs.keys()];
  }

  get size(): number {
    return this.jobs.size;
  }
}

/**
 * Enqueues a job by name through its definition.
 *
 * This is the call a feature module makes. It closes the gap between the queue, which stores
 * bytes, and the registry, which knows what those bytes mean: the name must exist, the payload is
 * validated before it is stored, and the attempt ceiling comes from the definition rather than
 * from whatever the caller remembered to pass.
 *
 * A rejected payload throws here, at the call site, where the request that produced it can answer
 * with a validation error. That is the opposite of storing it and letting a worker fail later.
 */
export async function enqueueJob(
  deps: { readonly registry: JobRegistry; readonly queue: JobQueue },
  name: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const job = deps.registry.get(name);
  const parsed = job.parsePayload(payload);

  return deps.queue.enqueue(name, parsed, {
    ...options,
    maxAttempts: options.maxAttempts ?? job.maxAttempts,
  });
}

function createRegisteredJob<TPayload>(definition: JobDefinition<TPayload>): RegisteredJob {
  return {
    name: definition.name,
    maxAttempts: definition.maxAttempts ?? appConfig.jobs.defaultMaxAttempts,
    timeoutMs: definition.timeoutMs ?? appConfig.jobs.jobTimeoutSeconds * 1000,
    parsePayload: (payload: unknown): unknown => definition.payloadSchema.parse(payload),
    run: async (context: JobContext<unknown>): Promise<void> => {
      // The payload was produced by `parsePayload` for this attempt, so its type is the
      // definition's payload type. This is the single cast in the module and it sits on the
      // boundary the schema already guards.
      await definition.handler({ ...context, payload: context.payload as TPayload });
    },
  };
}
