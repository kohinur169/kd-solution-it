// path: docs/planning/STEP_011_SUBSTEP_BREAKDOWN.md
# STEP 011 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 011, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS as the
runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 011 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 011 - Background job queue, worker and scheduler foundation with health
  check route.
- Category: Foundation and Configuration (STEP 001-011). This is the last foundation STEP; the
  next category is the database.
- Previous handoff read: docs/handoffs/STEP_010_COMPLETED.md. It records that `AppProviders` is
  the single client boundary, that `withErrorResponse` wraps every route, that the logger writes
  one line per unit of work, and that the job foundation (STEP 011) is still open.
- Ownership line from STEP_PLAN_250.md: "Database STEPs 012-036 own only their numbered
  migration files in migrations/". STEP 012 is titled "Migration for companies and background
  jobs queue tables". **The queue table is STEP 012's file, not this STEP's.** STEP 011 builds
  the queue, worker and scheduler contract plus the in-process store; STEP 012 creates the table
  and the SQL store follows.

### Feature list and master prompt requirements
- FEATURE_LIST section 27 lists the ten job families the platform must run: sub-merchant
  provisioning after KYC approval, email sending and retry, recurring invoices and client
  reminders, webhook processing, settlement release, subscription charge attempts and warnings,
  reconciliation checks, expired token and session cleanup, audit log integrity hashes, and
  compliance calendar alerts.
- FEATURE_LIST section 28: "Light runtime on Vercel and Netlify: PDF generation, email, webhook
  processing and sub-merchant provisioning run as background jobs. Request handlers validate,
  write minimal rows and enqueue."
- FEATURE_LIST section 32: "Background job monitoring: a failed or stalled job raises an office
  alert." A stalled job must therefore be detectable from the outside, which is what the health
  route and the snapshot are for.
- FEATURE_LIST section 33 and MASTER_PROMPT: typecheck, lint and build for the touched area.
- MASTER_PROMPT rule 5: structured logging only. Every job transition is a log line with the job
  id and the trace id, never a `console` call.
- MASTER_PROMPT rule 10: Zod validation on the server for every input. A job payload is an input,
  so it is validated by the job's own schema at enqueue and again before the handler runs.
- STEP 008 handoff: `retryable` and `retryAfterSeconds` are the job foundation's input; a retry
  loop branches on the flag, never on the message text.
- STEP 007 handoff: a job should run inside `runnerWithRequestContext` so every line it writes
  shares one trace id.

### What exists today (measured before coding)
- No `lib/jobs/` directory, no queue, no worker, no scheduler, no job route.
- `config/app.ts` has 9 sections and 22 values and nothing about jobs, so every limit would be a
  magic number.
- `app/api/health/route.ts` reports only process liveness; it says nothing about work that is
  queued or stuck.
- The logger, the error catalog and the request context are in place and are exactly the pieces a
  worker needs: a trace id, a retry signal and a redacting log line.

## 2. Design Decisions Taken Before Coding

1. **The contract comes before the store.** STEP 012 owns the table, so this STEP defines the
   `JobQueue` port, the `JobRecord` shape and an in-process implementation. A later STEP swaps
   the store behind the same port; the worker, the scheduler and the health route do not change.
2. **The in-process store is honest about itself.** It reports `store: "memory"` in its health
   snapshot and in its README, and it is documented as the development and gate store, not as a
   production guarantee. Pretending otherwise would be worse than the limitation.
3. **Payloads are validated twice.** The job's Zod schema parses the payload at enqueue and again
   before the handler runs, because a payload that was valid when written can be invalid after a
   deploy that changed the schema.
4. **Jobs are named, and the registry owns the name.** An unknown name is a defect, not a queued
   row that fails forever: `enqueue` throws `JobNotRegisteredError`.
5. **Retries use the error catalog, not the message.** An `AppError` with `retryable: false`
   (validation, permission, conflict) fails immediately; a retryable code or an unknown failure is
   retried with exponential backoff until `maxAttempts`.
6. **Every claim is a lease.** A reserved job carries `leaseExpiresAt`. If the process dies, the
   lease expires and the job returns to pending with its attempt count intact, which is what makes
   "stalled" measurable and recovery possible.
7. **A handler receives an `AbortSignal`.** Each attempt runs under a timeout; on expiry the
   signal aborts, the attempt is recorded as a `TIMEOUT` failure and the retry policy decides what
   happens next. A promise that never settles cannot hold a worker slot forever.
8. **Idempotency keys are enforced by the queue.** A second enqueue with the same key returns the
   existing job and marks the result `deduplicated`, which is how a retried webhook or a double
   submitted form stays one job.
9. **The scheduler is a slot clock, not a cron parser.** A schedule declares an interval and the
   scheduler derives a slot number from the clock; the idempotency key includes the slot, so two
   instances ticking at the same moment enqueue one job, not two. A five field cron parser is a
   package request for a later STEP, not a hand written parser here.
10. **A job runs in its own request context.** The worker opens `runWithRequestContext` with the
    job's trace id, then logs with `child({ jobId, jobName, attempt })`. Every line for one
    attempt is correlated, and the logger redacts whatever the handler logged.
11. **Limits live in configuration.** `config/app.ts` gains a `jobs` section (attempts, backoff
    base and ceiling, timeout, concurrency, stalled threshold) with invariants, so no magic number
    hides in the worker and the config gate keeps the numbers sane.
12. **Health is computed, not guessed.** The snapshot counts by status, reports the age of the
    oldest pending job and the number of expired leases, and the route answers `503` when the
    snapshot is degraded so an uptime monitor sees a red state without parsing JSON.
13. **No worker starts itself.** Starting a background loop at import time is how a serverless
    platform gets two workers and a bill; the runtime object is created on first use, the health
    route only reads it, and starting a loop is an explicit call that a deployment STEP will wire
    to a schedule.
14. **The gate runs the queue for real.** `npm run check:jobs` drives enqueue, run, retry,
    dead-letter, idempotency, lease recovery, timeout, concurrency, graceful stop, scheduling and
    the health thresholds through the actual classes, with an injected clock where time matters.

## 3. Why Five Sub-Steps

| Sub-step | Concern | Wrong without it |
| --- | --- | --- |
| 011.1 | Contract and inventory | A queue invented while the table owner is a different STEP, or limits as magic numbers |
| 011.2 | Job model, registry and configuration | An unknown name runs forever, or a payload is trusted twice |
| 011.3 | Queue store: leases, retries, idempotency | Two workers run one job, or a crash silently loses it |
| 011.4 | Worker, scheduler, runtime and health route | No timeout, no correlation, no visibility when work stalls |
| 011.5 | Gate, documentation and proof | A retry policy nobody has exercised, and an untested health signal |

## 4. The Five Sub-Steps

### 011.1 - Contract, inventory and ownership notes
- Read FEATURE_LIST section 27, 28 and 32, the MASTER_PROMPT rules, the STEP 007, 008 and 010
  handoffs and the STEP 012 title that owns the table (done above).
- Inventory: no jobs module, no job limits in configuration, a liveness-only health route.
- Fix the contract: port, record shape, statuses, retry policy, lease and idempotency semantics,
  scheduler slots, snapshot fields, route behaviour and gate scenarios.
- Deliverable: this document.

### 011.2 - Job model, registry and configuration
- `lib/jobs/types.ts`: statuses, `JobRecord`, `JobContext`, `JobDefinition`, `RegisteredJob`,
  enqueue and failure options, and the typed errors.
- `lib/jobs/registry.ts`: registration, duplicate rejection, unknown name rejection, payload
  parsing with the job's own schema.
- `config/app.ts`: a `jobs` section and its invariants; `config/README.md` updated.
- Proof: the gate registers, parses and refuses exactly as specified.

### 011.3 - Queue store with leases, retries and idempotency
- `lib/jobs/queue.ts`: the `JobQueue` port and `createInMemoryJobQueue`, with reserve, complete,
  fail (retry or dead letter), lease expiry recovery, idempotency dedupe and a snapshot.
- Proof: the gate exercises every transition with an injected clock.

### 011.4 - Worker, scheduler, runtime and health route
- `lib/jobs/worker.ts`: reserve, run under a timeout with an `AbortSignal`, classify the failure
  from the error catalog, schedule the retry with backoff, log each transition inside the job's
  request context, and stop gracefully.
- `lib/jobs/scheduler.ts`: interval schedules, slot based idempotency and a tick.
- `lib/jobs/health.ts`: the snapshot and its degraded rule.
- `lib/jobs/runtime.ts`: the single lazily created runtime the route reads.
- `app/api/jobs/health/route.ts`: the health route, wrapped in `withErrorResponse`, answering
  `200` or `503`.
- Proof: the gate drives the worker and the scheduler; the route is exercised on a running build.

### 011.5 - Job gate, documentation and handoff
- `lib/jobs/verify.ts`: `npm run check:jobs`, added to `npm run verify`.
- `lib/jobs/README.md` and a root README section.
- Finish with `npm run verify` on Node.js 26.13.0, the route proof on a production build, one
  commit, push and the completed handoff.

## 5. Files This STEP Owns

| File | Status |
| --- | --- |
| lib/jobs/types.ts | created in 011.2 |
| lib/jobs/registry.ts | created in 011.2 |
| lib/jobs/queue.ts | created in 011.3 |
| lib/jobs/worker.ts | created in 011.4 |
| lib/jobs/scheduler.ts | created in 011.4 |
| lib/jobs/health.ts | created in 011.4 |
| lib/jobs/runtime.ts | created in 011.4 |
| lib/jobs/verify.ts | created in 011.5 |
| lib/jobs/README.md | created in 011.5 |
| app/api/jobs/health/route.ts | created in 011.4 |
| config/app.ts (the `jobs` section and its invariants) | modified in 011.2 |
| config/README.md (the new section) | modified in 011.5 |
| package.json (the `check:jobs` script and the verify chain) | modified in 011.5 |
| README.md (background jobs section) | modified in 011.5 |
| docs/planning/STEP_011_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_011_COMPLETED.md | created in 011.5 |

Not owned here, therefore untouched: every migration, including the queue table that STEP 012
creates (STEP 012+), the environment contract (004), the string catalog (006), the logger (007),
the error catalog and envelope (008), the lint matrix (009), the shell and providers (010), the
public navigation (231-238), the provider adapters (147-175), the email templates (221-230) and
the deployment schedules (244-250).

## 6. Outcome

All five sub-steps were implemented in order, each with the owner's approval: 011.1 the
inventory, decisions and ownership table above; 011.2 the `jobs` configuration section, the types
and the registry; 011.3 the queue port and the in-memory store; 011.4 the worker, the scheduler,
the health snapshot, the runtime and `app/api/jobs/health/route.ts`; 011.5 the gate, the
documentation, the full verification run and this handoff.

Two additions came out of 011.5 that the design had implied but not named:

- `enqueueJob` in `lib/jobs/registry.ts`, because the queue stores bytes and only the registry
  knows the definition's attempt ceiling and schema. Feature code calls it, never
  `queue.enqueue`, so a payload is validated before it is stored.
- `healthStatus` in `lib/jobs/health.ts`, so the route's `200`/`503` decision is one function the
  gate can prove without a running server.

See `docs/handoffs/STEP_011_COMPLETED.md` for the proof and the measurements.
