// path: lib/jobs/runtime.ts
import { createInMemoryJobQueue, type JobQueue } from "./queue.ts";
import { JobRegistry } from "./registry.ts";
import { JobScheduler } from "./scheduler.ts";
import { JobWorker } from "./worker.ts";

/**
 * The job runtime.
 *
 * One place builds the queue, the registry, the scheduler and the worker, so a route, a test and a
 * future cron entry point share instances instead of each creating a private store. Registration
 * of real jobs happens through `registerJob`, which a feature module calls once; the runtime itself
 * registers nothing, so an empty registry is a valid, healthy state during the foundation STEP.
 *
 * The runtime is lazy. Importing this module starts no timer and opens no connection: the first
 * caller pays the construction cost, and the deployment STEP that owns background work decides
 * whether the worker should ever `start()`.
 */

export interface JobRuntime {
  readonly queue: JobQueue;
  readonly registry: JobRegistry;
  readonly scheduler: JobScheduler;
  readonly worker: JobWorker;
}

let runtime: JobRuntime | undefined;

export function createJobRuntime(): JobRuntime {
  const queue = createInMemoryJobQueue();
  const registry = new JobRegistry();
  const scheduler = new JobScheduler({ queue, registry });
  const worker = new JobWorker({ queue, registry });

  return { queue, registry, scheduler, worker };
}

/** The process-wide runtime. */
export function getJobRuntime(): JobRuntime {
  runtime ??= createJobRuntime();

  return runtime;
}
