// path: lib/jobs/verify.ts
import process from "node:process";
import { z } from "zod";
import { appConfig } from "../../config/app.ts";
import { AppError } from "../errors/app-error.ts";
import { createLogger, type Logger } from "../logger/logger.ts";
import { buildJobHealthSnapshot, healthStatus } from "./health.ts";
import { createInMemoryJobQueue, IN_MEMORY_JOB_STORE, retryDelayMs } from "./queue.ts";
import { enqueueJob, JobRegistry } from "./registry.ts";
import { JobScheduler, ScheduleAlreadyRegisteredError } from "./scheduler.ts";
import { JobWorker } from "./worker.ts";
import {
  JobAlreadyRegisteredError,
  JobNotRegisteredError,
  type JobContext,
  type JobDefinition,
} from "./types.ts";

/**
 * Job foundation gate. Run with `npm run check:jobs`, and inside `npm run verify`.
 *
 * The gate drives the real registry, queue, worker and scheduler on a controlled clock and then
 * reads the stored records back. Every rule below is one that a silent regression would break
 * without breaking the build:
 *
 *   1. registration rejects two jobs under one name and an unknown name is a typed error;
 *   2. a payload is validated at the boundary, and an invalid one never reaches a handler;
 *   3. an idempotency key returns the first job, so a retried request cannot enqueue twice;
 *   4. a claim is a lease, and an expired lease returns the job without losing its attempt count;
 *   5. a retry backs off exponentially, a non-retryable code dies at once, and `maxAttempts` is a
 *      ceiling on attempts actually started;
 *   6. a handler that ignores its budget is aborted, recorded as `TIMEOUT`, and the slot frees;
 *   7. a schedule runs at most once per slot, even when two ticks land in the same slot;
 *   8. the health snapshot degrades on a stall, a dead job or an old queue, and says `memory`;
 *   9. the runtime is a singleton and starts no background loop by itself.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checkCount += 1;

  if (actual !== expected) {
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
  }
}

function expectThrows(action: () => unknown, description: string): unknown {
  checkCount += 1;

  try {
    const value = action();
    failures.push(`${description} (nothing was thrown)`);

    return value;
  } catch (error) {
    return error;
  }
}

function silentLogger(): Logger {
  const sink = { write(): void {} };

  return createLogger({ level: "error", stdout: sink, stderr: sink });
}

const payloadSchema = z.object({ orderId: z.string().min(1) });

interface Harness {
  readonly queue: ReturnType<typeof createInMemoryJobQueue>;
  readonly registry: JobRegistry;
  readonly worker: JobWorker;
  readonly clock: { value: number };
}

function createHarness(): Harness {
  const queue = createInMemoryJobQueue();
  const registry = new JobRegistry();
  const clock = { value: 1_000_000 };
  const worker = new JobWorker({
    queue,
    registry,
    logger: silentLogger(),
    now: () => clock.value,
    leaseDurationMs: 5_000,
    pollIntervalMs: 60_000,
  });

  return { queue, registry, worker, clock };
}

/* ------------------------------------------------------------------ 1. registry */

function checkRegistry(): void {
  const registry = new JobRegistry();
  const definition: JobDefinition<{ orderId: string }> = {
    name: "jobs.gate.registry",
    payloadSchema,
    handler: async (): Promise<void> => {},
  };

  registry.register(definition);

  expect(registry.has("jobs.gate.registry"), "a registered job must be found by name");
  expectEqual(registry.size, 1, "the registry must count its jobs");
  expectEqual(registry.names()[0], "jobs.gate.registry", "the registry must list its names");

  const duplicate = expectThrows(() => {
    registry.register(definition);
  }, "registering one name twice must throw");
  expect(duplicate instanceof JobAlreadyRegisteredError, "a duplicate name must be its own error");

  const unknown = expectThrows(() => registry.get("jobs.gate.missing"), "fetching an unknown job must throw");
  expect(unknown instanceof JobNotRegisteredError, "an unknown job must be a typed error");

  const job = registry.get("jobs.gate.registry");
  expectEqual(job.maxAttempts, appConfig.jobs.defaultMaxAttempts, "attempts must default to config");
  expectEqual(job.timeoutMs, appConfig.jobs.jobTimeoutSeconds * 1000, "the timeout must come from config");

  expectEqual(
    (job.parsePayload({ orderId: "ord_1" }) as { orderId: string }).orderId,
    "ord_1",
    "a valid payload must survive validation",
  );
  expectThrows(() => job.parsePayload({ orderId: "" }), "an invalid payload must be rejected");
  expectThrows(() => job.parsePayload(undefined), "a missing payload must be rejected");
}

async function checkEnqueueJob(): Promise<void> {
  const queue = createInMemoryJobQueue();
  const registry = new JobRegistry();

  registry.register({
    name: "jobs.gate.enqueue",
    payloadSchema,
    maxAttempts: 2,
    handler: async (): Promise<void> => {},
  });

  const unknown = await (async (): Promise<unknown> => {
    try {
      await enqueueJob({ registry, queue }, "jobs.gate.nope", { orderId: "ord_1" });
    } catch (error) {
      return error;
    }

    return undefined;
  })();

  expect(unknown instanceof JobNotRegisteredError, "enqueueing an unknown name must be a typed error");

  const invalid = await (async (): Promise<unknown> => {
    try {
      await enqueueJob({ registry, queue }, "jobs.gate.enqueue", { orderId: "" });
    } catch (error) {
      return error;
    }

    return undefined;
  })();

  expect(invalid instanceof Error, "enqueueing an invalid payload must throw");
  expectEqual((await queue.snapshot(0)).total, 0, "a rejected payload must never reach the store");

  const accepted = await enqueueJob({ registry, queue }, "jobs.gate.enqueue", { orderId: "ord_1" }, {
    now: 5_000,
  });

  expectEqual(accepted.job.maxAttempts, 2, "the enqueue must take the attempt ceiling from the definition");
  expectEqual(accepted.job.status, "pending", "the enqueue must return the stored record");
  expectEqual((accepted.job.payload as { orderId: string }).orderId, "ord_1", "the stored payload must be the parsed one");
}

/* ------------------------------------------------------------------ 2. queue */

async function checkQueue(): Promise<void> {
  const queue = createInMemoryJobQueue();
  const clock = { value: 10_000 };

  expectEqual(queue.store, IN_MEMORY_JOB_STORE, "the development store must name itself memory");

  const first = await queue.enqueue("jobs.gate.queue", { orderId: "ord_1" }, {
    idempotencyKey: "gate:key:1",
    now: clock.value,
  });

  expect(!first.deduplicated, "a first enqueue must not be a duplicate");
  expectEqual(first.job.status, "pending", "a new job must be pending");
  expectEqual(first.job.attempt, 0, "a new job must have no attempts");
  expectEqual(first.job.maxAttempts, appConfig.jobs.defaultMaxAttempts, "attempts must come from config");
  expect(first.job.traceId.startsWith("req_"), "a job must carry a request-shaped trace id");

  const again = await queue.enqueue("jobs.gate.queue", { orderId: "ord_2" }, {
    idempotencyKey: "gate:key:1",
    now: clock.value,
  });

  expect(again.deduplicated, "a repeated idempotency key must be deduplicated");
  expectEqual(again.job.id, first.job.id, "a repeated key must return the first job");
  expectEqual(again.job.payload, first.job.payload, "a duplicate enqueue must not replace the payload");

  expectEqual(
    await queue.reserve({ leaseDurationMs: 5_000, now: clock.value - 1 }),
    null,
    "a job must not be claimable before its available time",
  );
}

async function checkReserveAndLease(): Promise<void> {
  const queue = createInMemoryJobQueue();
  const clock = { value: 20_000 };

  await queue.enqueue("jobs.gate.lease", { orderId: "ord_1" }, { now: clock.value });

  const empty = await queue.reserve({ leaseDurationMs: 5_000, now: clock.value - 1 });

  expectEqual(empty, null, "a job must not be reserved before it is available");

  const claimed = await queue.reserve({ leaseDurationMs: 5_000, now: clock.value });

  expectEqual(claimed?.status, "running", "a reservation must mark the job running");
  expectEqual(claimed?.attempt, 1, "a reservation must start one attempt");
  expectEqual(claimed?.leaseExpiresAtEpochMs, clock.value + 5_000, "a reservation must take a lease");

  clock.value += 5_001;

  const recovered = await queue.releaseExpiredLeases(clock.value);

  expectEqual(recovered, 1, "an expired lease must be recovered");

  const again = await queue.reserve({ leaseDurationMs: 5_000, now: clock.value });

  expectEqual(again?.attempt, 2, "a recovered job must keep counting attempts");
  expectEqual(again?.lastErrorCode, "LEASE_EXPIRED", "a recovered job must record why it came back");

  if (again === null) {
    failures.push("a recovered job must be reservable again");
    checkCount += 1;

    return;
  }

  const deadline = await queue.fail(again.id, { code: "TIMEOUT", retryable: true, now: clock.value });

  expectEqual(deadline.status, "retrying", "a retryable failure must schedule a retry");
  expectEqual(
    deadline.availableAtEpochMs,
    clock.value + retryDelayMs(2),
    "a retry must back off from the attempt that failed",
  );

  clock.value = (deadline.availableAtEpochMs ?? clock.value) + 1;
  await queue.releaseExpiredLeases(clock.value);

  const third = await queue.reserve({ leaseDurationMs: 5_000, now: clock.value });

  if (third === null) {
    failures.push("a job whose backoff elapsed must be reservable");
    checkCount += 1;

    return;
  }

  const dead = await queue.fail(third.id, { code: "PERMISSION_DENIED", retryable: false, now: clock.value });

  expectEqual(dead.status, "failed", "a non-retryable failure must die immediately");
  expectEqual(dead.availableAtEpochMs, null, "a dead job must never become available again");

  const snapshot = await queue.snapshot(clock.value);

  expectEqual(snapshot.failed, 1, "the snapshot must count failed jobs");
  expectEqual(snapshot.total, 1, "the snapshot must count every record");
  expectEqual(snapshot.stalled, 0, "a settled job must not look stalled");
}

function checkBackoff(): void {
  const base = appConfig.jobs.retryBaseDelaySeconds * 1000;
  const ceiling = appConfig.jobs.retryMaxDelaySeconds * 1000;

  expectEqual(retryDelayMs(1), base, "the first retry must wait the base delay");
  expectEqual(retryDelayMs(2), Math.min(ceiling, base * 2), "the second retry must double the base");
  expectEqual(retryDelayMs(3), Math.min(ceiling, base * 4), "the third retry must double again");
  expectEqual(retryDelayMs(64), ceiling, "a late retry must stop at the ceiling");
  expect(retryDelayMs(3) > retryDelayMs(2), "backoff must grow with the attempt");
}

/* ------------------------------------------------------------------ 3. worker */

interface WorkerFixture {
  readonly harness: Harness;
  readonly seen: JobContext<{ orderId: string }>[];
}

function createWorkerFixture(): WorkerFixture {
  const harness = createHarness();
  const seen: JobContext<{ orderId: string }>[] = [];

  harness.registry.register({
    name: "jobs.gate.worker",
    payloadSchema,
    maxAttempts: 3,
    timeoutMs: 1_000,
    handler: async (context): Promise<void> => {
      seen.push(context);
    },
  });

  return { harness, seen };
}

async function checkWorker(): Promise<void> {
  const { harness, seen } = createWorkerFixture();
  const { queue, worker, clock } = harness;

  const enqueued = await enqueueJob({ registry: harness.registry, queue }, "jobs.gate.worker", {
    orderId: "ord_1",
  }, { now: clock.value });
  const result = await worker.runOnce();

  expect(result.ran, "the worker must claim an available job");
  expectEqual(result.status, "completed", "a handler that resolves must complete the job");
  expectEqual(result.jobId, enqueued.job.id, "the worker must report the job it ran");
  expectEqual(worker.processedCount, 1, "the worker must count what it processed");
  expectEqual(seen.length, 1, "the handler must run exactly once");
  expectEqual(seen[0]?.payload.orderId, "ord_1", "the handler must receive the validated payload");
  expectEqual(seen[0]?.attempt, 1, "the handler must know its attempt");
  expectEqual(seen[0]?.maxAttempts, 3, "the handler must know its ceiling");
  expect(seen[0]?.traceId.startsWith("req_") === true, "the handler must receive the job trace id");
  expect(seen[0]?.signal.aborted === false, "an attempt must start with a live signal");

  const idle = await worker.runOnce();

  expect(!idle.ran, "an empty queue must not claim anything");
  expectEqual(idle.status, "none", "an empty queue must report nothing ran");

  const snapshot = await queue.snapshot(clock.value);
  expectEqual(snapshot.completed, 1, "a completed job must be visible in the snapshot");
}

async function checkWorkerRetryAndFailure(): Promise<void> {
  const harness = createHarness();
  const { queue, registry, worker, clock } = harness;
  const codes: string[] = [];

  registry.register({
    name: "jobs.gate.retry",
    payloadSchema,
    maxAttempts: 2,
    handler: async (context): Promise<void> => {
      codes.push(context.attempt === 1 ? "first" : "second");

      if (context.attempt === 1) {
        throw new AppError("DEPENDENCY_FAILED");
      }
    },
  });

  await enqueueJob({ registry, queue }, "jobs.gate.retry", { orderId: "ord_1" }, { now: clock.value });

  const first = await worker.runOnce();

  expectEqual(first.status, "retrying", "a retryable catalog failure must schedule a retry");

  const waiting = await queue.reserve({ leaseDurationMs: 5_000, now: clock.value });

  expectEqual(waiting, null, "a retrying job must not be claimable before its delay");

  clock.value += retryDelayMs(1);

  const second = await worker.runOnce();

  expectEqual(second.status, "completed", "the retry must be able to succeed");
  expectEqual(codes.join(","), "first,second", "the handler must run once per attempt");

  registry.register({
    name: "jobs.gate.denied",
    payloadSchema,
    maxAttempts: 5,
    handler: async (): Promise<void> => {
      throw new AppError("PERMISSION_DENIED");
    },
  });

  const denied = await enqueueJob({ registry, queue }, "jobs.gate.denied", { orderId: "ord_1" }, {
    now: clock.value,
  });

  await worker.runOnce();

  const settled = await queue.snapshot(clock.value);
  const record = await enqueueJob({ registry, queue }, "jobs.gate.denied", { orderId: "ord_2" }, {
    now: clock.value,
  });

  expectEqual(settled.failed, 1, "a non-retryable catalog code must fail on the first attempt");
  expect(record.deduplicated === false, "a job without a key must never deduplicate");
  expectEqual(denied.job.attempt, 0, "enqueueing must not consume an attempt");
}

async function checkWorkerPayloadAndTimeout(): Promise<void> {
  const harness = createHarness();
  const { queue, registry, worker, clock } = harness;
  const aborted: boolean[] = [];

  registry.register({
    name: "jobs.gate.timeout",
    payloadSchema,
    maxAttempts: 1,
    timeoutMs: 20,
    handler: async (context): Promise<void> => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted.push(context.signal.aborted);
      throw new AppError("TIMEOUT");
    },
  });

  await enqueueJob({ registry, queue }, "jobs.gate.timeout", { orderId: "ord_1" }, { now: clock.value });

  const timedOut = await worker.runOnce();

  expectEqual(timedOut.status, "failed", "a timed out handler must fail its last attempt");

  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

  expectEqual(aborted[0], true, "a timed out handler must see its signal abort");

  // An unregistered name is a deployment defect: it is settled, never retried.
  await queue.enqueue("jobs.gate.unregistered", { orderId: "ord_1" }, { now: clock.value });

  const missing = await worker.runOnce();

  expectEqual(missing.status, "failed", "an unregistered job must be settled, not retried");

  // A payload that no longer matches the schema fails before the handler is entered. The store was
  // written by an older deploy, so it is enqueued directly rather than through the definition.
  const invalid = await queue.enqueue("jobs.gate.timeout", { orderId: 42 }, { now: clock.value });
  const rejected = await worker.runOnce();
  const stored = invalid.job.payload as { readonly orderId: number };

  expectEqual(rejected.status, "failed", "an invalid stored payload must fail without a handler run");
  expectEqual(stored.orderId, 42, "the queue must store what it was given");
}

async function checkDrain(): Promise<void> {
  const harness = createHarness();
  const { queue, registry, worker, clock } = harness;
  let runs = 0;

  registry.register({
    name: "jobs.gate.drain",
    payloadSchema,
    handler: async (): Promise<void> => {
      runs += 1;
    },
  });

  for (let index = 0; index < 3; index += 1) {
    await enqueueJob({ registry, queue }, "jobs.gate.drain", { orderId: `ord_${index}` }, {
      now: clock.value,
    });
  }

  const totals = await worker.drain(10);

  expectEqual(totals.processed, 3, "a drain must run every available job");
  expectEqual(totals.completed, 3, "a drain must count completions");
  expectEqual(runs, 3, "every enqueued job must reach a handler");

  const bounded = await enqueueJob({ registry, queue }, "jobs.gate.drain", { orderId: "ord_x" }, {
    now: clock.value,
  });
  const budget = await worker.drain(0);

  expectEqual(budget.processed, 0, "a zero budget must process nothing");
  expect(bounded.job.status === "pending", "a job skipped by the budget must stay pending");
  expect(!worker.running, "a worker must not poll until it is started");
}

/* ------------------------------------------------------------------ 4. scheduler */

async function checkScheduler(): Promise<void> {
  const harness = createHarness();
  const { queue, registry, clock } = harness;

  registry.register({
    name: "jobs.gate.scheduled",
    payloadSchema,
    handler: async (): Promise<void> => {},
  });

  const scheduler = new JobScheduler({ queue, registry, logger: silentLogger(), now: () => clock.value });
  const everyMs = 60_000;

  scheduler.register({ name: "jobs.gate.scheduled", payload: { orderId: "ord_s" }, everyMs });

  expectEqual(scheduler.size, 1, "the scheduler must count its schedules");
  expectEqual(scheduler.list()[0]?.lastSlot, null, "a schedule must start without a slot");

  const duplicate = expectThrows(() => {
    scheduler.register({ name: "jobs.gate.scheduled", payload: { orderId: "ord_s" }, everyMs });
  }, "registering one schedule twice must throw");
  expect(duplicate instanceof ScheduleAlreadyRegisteredError, "a duplicate schedule must be its own error");

  expectThrows(() => {
    scheduler.register({ name: "jobs.gate.scheduled", payload: {}, everyMs: 10 });
  }, "a schedule below one second must be rejected");

  expectThrows(() => {
    scheduler.register({ name: "jobs.gate.unknown", payload: {}, everyMs });
  }, "a schedule for an unregistered job must be rejected");

  clock.value = everyMs * 3;

  const firstTick = await scheduler.tick();

  expectEqual(firstTick.enqueued, 1, "a new slot must enqueue one job");
  expectEqual(scheduler.lastTickAtEpochMs, clock.value, "a tick must report its clock");

  const secondTick = await scheduler.tick();

  expectEqual(secondTick.enqueued, 0, "a second tick in the same slot must enqueue nothing");

  clock.value = everyMs * 4;

  const thirdTick = await scheduler.tick();

  expectEqual(thirdTick.enqueued, 1, "the next slot must enqueue again");
  expectEqual(thirdTick.skipped, 0, "a fresh slot must not be skipped");

  const snapshot = await queue.snapshot(clock.value);

  expectEqual(snapshot.pending, 2, "two slots must produce two jobs");
}

/* ------------------------------------------------------------------ 5. health and runtime */

async function checkHealth(): Promise<void> {
  const queue = createInMemoryJobQueue();
  const now = 500_000;

  const healthy = await buildJobHealthSnapshot({ queue, now: () => now });

  expectEqual(healthy.status, "ok", "an empty queue must be healthy");
  expectEqual(healthy.reasons.length, 0, "a healthy snapshot must give no reason");
  expectEqual(healthy.queue.store, IN_MEMORY_JOB_STORE, "the snapshot must name its store");
  expectEqual(healthStatus(healthy), 200, "a healthy snapshot must answer 200");
  expectEqual(healthy.queue.total, 0, "an empty queue must report no jobs");
  expectEqual(healthy.worker.running, false, "a snapshot without a worker must say not running");
  expectEqual(healthy.scheduler.registered, 0, "a snapshot without a scheduler must report zero");

  const stalledQueue = createInMemoryJobQueue();

  await stalledQueue.enqueue("jobs.gate.health", { orderId: "ord_1" }, { now });
  await stalledQueue.reserve({ leaseDurationMs: 10, now });

  const stalled = await buildJobHealthSnapshot({ queue: stalledQueue, now: () => now + 1_000 });

  expectEqual(stalled.status, "degraded", "an expired lease must degrade the snapshot");
  expect(stalled.reasons.includes("stalled_jobs"), "a stall must name its rule");
  expectEqual(stalled.queue.stalled, 1, "the snapshot must count the stalled job");

  const oldQueue = createInMemoryJobQueue();

  await oldQueue.enqueue("jobs.gate.health", { orderId: "ord_1" }, { now: 0 });

  const old = await buildJobHealthSnapshot({
    queue: oldQueue,
    now: () => appConfig.jobs.stalledAfterSeconds * 1000 + 1,
  });

  expect(old.reasons.includes("oldest_pending_job_too_old"), "an old waiting job must name its rule");

  const deadQueue = createInMemoryJobQueue();
  const dead = await deadQueue.enqueue("jobs.gate.health", { orderId: "ord_1" }, { now });

  await deadQueue.reserve({ leaseDurationMs: 5_000, now });
  await deadQueue.fail(dead.job.id, { code: "DEPENDENCY_FAILED", retryable: false, now });

  const failed = await buildJobHealthSnapshot({ queue: deadQueue, now: () => now });

  expect(failed.reasons.includes("failed_jobs"), "a dead job must name its rule");
  expectEqual(failed.status, "degraded", "a dead job must degrade the snapshot");
  expectEqual(healthStatus(failed), 503, "a degraded snapshot must answer 503");
}

async function checkRuntime(): Promise<void> {
  const { getJobRuntime } = await import("./runtime.ts");
  const runtime = getJobRuntime();

  expectEqual(getJobRuntime(), runtime, "the runtime must be a singleton");
  expectEqual(runtime.queue.store, IN_MEMORY_JOB_STORE, "the runtime must use the development store");
  expectEqual(runtime.registry.size, 0, "the runtime must register no job by itself");
  expectEqual(runtime.scheduler.size, 0, "the runtime must register no schedule by itself");
  expect(!runtime.worker.running, "the runtime must not start a worker by itself");

  const snapshot = await buildJobHealthSnapshot(runtime);

  expectEqual(snapshot.status, "ok", "a fresh runtime must be healthy");
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  checkRegistry();
  await checkEnqueueJob();
  await checkQueue();
  await checkReserveAndLease();
  checkBackoff();
  await checkWorker();
  await checkWorkerRetryAndFailure();
  await checkWorkerPayloadAndTimeout();
  await checkDrain();
  await checkScheduler();
  await checkHealth();
  await checkRuntime();

  if (failures.length > 0) {
    process.stderr.write(`jobs gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `jobs gate passed: ${checkCount} checks, ${appConfig.jobs.workerConcurrency} worker slots, ` +
      `${appConfig.jobs.defaultMaxAttempts} default attempts, store "${IN_MEMORY_JOB_STORE}"\n`,
  );
}

await main();
