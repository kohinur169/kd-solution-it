// path: lib/jobs/health.ts
import { appConfig } from "../../config/app.ts";
import type { JobQueue } from "./queue.ts";
import type { JobScheduler } from "./scheduler.ts";
import type { JobWorker } from "./worker.ts";

/**
 * The job health snapshot.
 *
 * `/api/health` answers "is this process alive". This answers the different question an operator
 * asks during an incident: "is background work moving". The platform degrades when work is stuck
 * (a claim whose lease expired), when the oldest waiting job is older than the configured stall
 * window, or when a job has died after its last attempt -- each of those means a merchant is
 * waiting for something that will not happen.
 *
 * The snapshot is data with a `status` field, not an exception: the route turns `degraded` into
 * 503 so a probe can act on it, while the body still explains which rule fired.
 */

export interface JobHealthQueue {
  readonly store: string;
  readonly pending: number;
  readonly running: number;
  readonly retrying: number;
  readonly completed: number;
  readonly failed: number;
  readonly total: number;
  readonly oldestPendingAgeSeconds: number;
  readonly stalled: number;
}

export interface JobHealthScheduler {
  readonly registered: number;
  readonly lastTickAt: string | null;
}

export interface JobHealthWorker {
  readonly processed: number;
  readonly running: boolean;
}

export interface JobHealthSnapshot {
  readonly status: "ok" | "degraded";
  /** One machine readable sentence per rule that fired. Empty while healthy. */
  readonly reasons: readonly string[];
  readonly checkedAt: string;
  readonly queue: JobHealthQueue;
  readonly scheduler: JobHealthScheduler;
  readonly worker: JobHealthWorker;
}

/**
 * The HTTP status a probe should see.
 *
 * Kept beside the rules rather than in the route: the gate can then prove both branches without a
 * running server, and every future caller of the snapshot agrees with the route about what
 * `degraded` means.
 */
export function healthStatus(snapshot: JobHealthSnapshot): 200 | 503 {
  return snapshot.status === "ok" ? 200 : 503;
}

export interface JobHealthInput {
  readonly queue: JobQueue;
  readonly scheduler?: JobScheduler;
  readonly worker?: JobWorker;
  /** Injected clock, used by the gate. */
  readonly now?: () => number;
}

export async function buildJobHealthSnapshot(input: JobHealthInput): Promise<JobHealthSnapshot> {
  const now = input.now ?? (() => Date.now());
  const checkedAtEpochMs = now();
  const snapshot = await input.queue.snapshot(checkedAtEpochMs);
  const stallWindowMs = appConfig.jobs.stalledAfterSeconds * 1000;
  const lastTickAtEpochMs = input.scheduler?.lastTickAtEpochMs ?? null;
  const reasons: string[] = [];

  if (snapshot.stalled > 0) {
    reasons.push("stalled_jobs");
  }

  if (snapshot.oldestPendingAgeMs > stallWindowMs) {
    reasons.push("oldest_pending_job_too_old");
  }

  if (snapshot.failed > 0) {
    reasons.push("failed_jobs");
  }

  return {
    status: reasons.length === 0 ? "ok" : "degraded",
    reasons,
    checkedAt: new Date(checkedAtEpochMs).toISOString(),
    queue: {
      store: input.queue.store,
      pending: snapshot.pending,
      running: snapshot.running,
      retrying: snapshot.retrying,
      completed: snapshot.completed,
      failed: snapshot.failed,
      total: snapshot.total,
      oldestPendingAgeSeconds: Math.floor(snapshot.oldestPendingAgeMs / 1000),
      stalled: snapshot.stalled,
    },
    scheduler: {
      registered: input.scheduler?.size ?? 0,
      lastTickAt:
        lastTickAtEpochMs === null ? null : new Date(lastTickAtEpochMs).toISOString(),
    },
    worker: {
      processed: input.worker?.processedCount ?? 0,
      running: input.worker?.running ?? false,
    },
  };
}
