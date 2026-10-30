// path: lib/jobs/README.md
# lib/jobs/

Owner: STEP 011 (background job foundation). Later STEPs add jobs, schedules and a database
store behind the same port; they do not add a second queue.

| File | Purpose |
| --- | --- |
| types.ts | `JobStatus`, `JobRecord`, the enqueue, reserve and failure contracts, `JobContext`, `JobDefinition`, the two registration errors |
| registry.ts | `JobRegistry`, `register` / `get` / `has` / `names`, and `enqueueJob`, which validates a payload and applies the definition's ceiling |
| queue.ts | The `JobQueue` port, `retryDelayMs`, and `InMemoryJobQueue` for development and the gate |
| worker.ts | `JobWorker`: claim a lease, run one attempt under a timeout, classify the failure, settle the record |
| scheduler.ts | `JobScheduler`: interval schedules split into slots, one job per slot |
| health.ts | `buildJobHealthSnapshot`: queue counts, stall age, degraded rules |
| runtime.ts | `getJobRuntime`: one lazy queue, registry, scheduler and worker per process |
| verify.ts | The gate behind `npm run check:jobs`, also part of `npm run verify` |

The HTTP surface is `app/api/jobs/health/route.ts`: `200` while work is moving, `503` when the
snapshot is degraded, so a probe can tell "the process answers" apart from "the queue is stuck".

## Rules

1. A job is a name, a schema and a handler. Register it once with `registry.register`, then
   enqueue it with `enqueueJob`; never call `queue.enqueue` from feature code, because that skips
   both validation and the definition's attempt ceiling.
2. A job name never changes after release. A renamed job leaves stored records that no deploy can
   run, and the worker settles them as `INTERNAL_ERROR` rather than retrying forever.
3. The payload is small and self sufficient: identifiers, not documents. It is validated at
   enqueue and again before the handler runs, so a schema change turns an old payload into a clear
   `VALIDATION_FAILED` instead of a crash.
4. `attempt` counts attempts started. `maxAttempts` is a ceiling on those attempts, and backoff
   is `min(ceiling, base * 2^(attempt-1))` from `config.appConfig.jobs`; do not hard code a delay
   in a handler.
5. Retryability comes from the error catalog in `lib/errors/codes.ts`, not from a handler's
   opinion. Throw an `AppError` with a catalog code and the worker does the right thing; a
   `PERMISSION_DENIED` or `VALIDATION_FAILED` dies on the first attempt.
6. A handler must honour `context.signal`. The worker aborts the signal at the definition's
   timeout, records `TIMEOUT`, and frees the slot. A handler that ignores it keeps running after
   the record is settled, which is a leak, not a retry.
7. A claim is a lease. Do not delete a running record and do not reschedule by hand; an expired
   lease is returned to the queue by `releaseExpiredLeases`, and the attempt counter survives, so
   a job that kills its worker cannot loop forever.
8. Use the job's `traceId` as the `requestId` of its request context. The worker already does;
   a handler that spawns work passes it on, so one merchant action is one trace.
9. Nothing starts a background loop at import time. `getJobRuntime()` builds objects; `start()`
   is a deployment decision, because a serverless platform would otherwise grow a worker per
   instance.
10. A schedule runs at most once per slot: the slot index is part of the idempotency key, so two
    instances ticking at the same second enqueue one job. Schedules name a registered job; a
    schedule for an unknown name is rejected where the mistake is.
11. Health is data. `degraded` means work is stuck, the oldest waiting job is older than
    `stalledAfterSeconds`, or a job died; the response carries the reasons, so an incident starts
    from a list, not from a guess.
12. Every change keeps the gate green: `npm run check:jobs` drives registration, validation,
    idempotency, leases, backoff, timeouts, scheduling, health and the runtime singleton.

## Adding a job

1. Define the payload schema next to the feature that owns it, with `zod`.
2. Register the job once, at module load of that feature, on the runtime's registry.
3. Enqueue with `enqueueJob` and a stable idempotency key when the caller can run twice: an
   invoice id, an order id, a `provider:event` id. Never a random value, which defeats the point.
4. Add one gate scenario in `verify.ts` when the job introduces a new rule; the existing
   scenarios already cover the lifecycle itself.
