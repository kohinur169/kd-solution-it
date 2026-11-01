// path: docs/handoffs/STEP_011_COMPLETED.md
# STEP 011 Completed - Handoff

## STEP
- Number and title: STEP 011 - Background job queue, worker and scheduler foundation with health
  check route
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (the folder tree
  and the `app/api` convention this route follows), STEP 002 (strict TypeScript and the `@/`
  alias), STEP 004 (the environment contract, untouched), STEP 005 (the typed configuration
  mechanism the new `jobs` section extends), STEP 006 (the catalog, which this STEP deliberately
  did not change because no new user facing string exists), STEP 007 (the structured logger, the
  request context and the redaction every job log line goes through), STEP 008 (the error catalog
  whose `retryable` flag decides a retry, `AppError`, and `withErrorResponse` which wraps the new
  route) and STEP 009 (the lint matrix the new modules satisfy).

## Files
- Created:
  - lib/jobs/types.ts - `JobStatus`, `JobRecord`, the enqueue, reserve and failure contracts,
    `JobContext`, `JobDefinition`, `RegisteredJob`, and the two registration errors.
  - lib/jobs/registry.ts - `JobRegistry` and `enqueueJob`, which validates a payload and applies
    the definition's attempt ceiling before the queue stores anything.
  - lib/jobs/queue.ts - the `JobQueue` port, `retryDelayMs`, `InMemoryJobQueue` and
    `createInMemoryJobQueue`.
  - lib/jobs/worker.ts - `JobWorker`: lease a job, run one attempt under a timeout with an
    `AbortSignal`, classify the failure from the catalog, settle the record, poll on demand.
  - lib/jobs/scheduler.ts - `JobScheduler`: interval schedules divided into slots, one job per
    slot, the slot index inside the idempotency key.
  - lib/jobs/health.ts - `buildJobHealthSnapshot`, the degraded rules, and `healthStatus`.
  - lib/jobs/runtime.ts - `createJobRuntime` and the lazy `getJobRuntime` singleton.
  - lib/jobs/verify.ts - the gate behind `npm run check:jobs`.
  - lib/jobs/README.md - the module map and twelve rules for writing a job.
  - app/api/jobs/health/route.ts - the background work readiness endpoint.
  - docs/planning/STEP_011_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_011_COMPLETED.md.
- Modified:
  - config/app.ts - a `jobs` section: `defaultMaxAttempts` 5, `retryBaseDelaySeconds` 15,
    `retryMaxDelaySeconds` 900, `jobTimeoutSeconds` 120, `workerConcurrency` 4,
    `stalledAfterSeconds` 300, with invariants (attempts 1-20, ceiling at least the base,
    concurrency 1-64, a timeout of at least a second).
  - config/README.md - the `app.ts` row and a rule saying the job limits are hard limits.
  - package.json - `check:jobs` added; `verify` now runs the job gate after the shell gate.
  - README.md - a "Background jobs" section and the commands table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/jobs/`,
  `app/api/jobs/`, the `jobs` section of `config/app.ts`, `config/README.md`, the `check:jobs`
  line and the verify chain in `package.json`, the root README. Not touched: every migration
  (the queue table is STEP 012), the environment contract (004), the catalog (006), the logger
  (007), the error catalog and envelope (008), the lint matrix (009), the shell and providers
  (010), `app/api/health` (which stays the liveness endpoint), the providers (147-175), the email
  templates (221-230), the public navigation (231-238) and the deployment schedules (244-250).

## Database
- Migrations added (file names): none. The queue table is STEP 012, which implements the
  `JobQueue` port; nothing in this STEP reads or writes a database.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. The job limits are code level defaults in
  `config/app.ts`, and a per-job timeout belongs to the job definition.
- Secrets handled (names only, never values): none. The store holds payloads, and no payload is
  logged: the worker logs `jobId`, `jobName`, `attempt` and an error code.

## Packages
- Package requests for the integrator (name, reason), or none: none. The scheduler uses the
  built-in clock rather than a cron parser, and `zod` (needed by the registry) is already a
  dependency.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.

  **1. The route answers on a production server.** A `next build` + `next start` on port 3200
  returned `200` from `GET /api/jobs/health` with
  `cache-control: no-store, max-age=0`, `content-type: application/json; charset=utf-8`,
  `x-content-type-options: nosniff` and the body
  `{"status":"ok","reasons":[],"checkedAt":"2026-10-30T18:29:09.870Z","queue":{"store":"memory","pending":0,"running":0,"retrying":0,"completed":0,"failed":0,"total":0,"oldestPendingAgeSeconds":0,"stalled":0},"scheduler":{"registered":0,"lastTickAt":null},"worker":{"processed":0,"running":false}}`.
  `/api/health` still answered `200`, so liveness and readiness remain separate endpoints. The
  build route table is `○ /`, `○ /_not-found`, `ƒ /api/health`, `ƒ /api/jobs/health`.

  **2. A job runs, and its payload is what the schema produced.** A registered job with a
  `z.object({ orderId: z.string().min(1) })` schema received `{ orderId: "ord_1" }` exactly once,
  with `attempt: 1`, `maxAttempts: 3` (from the definition, not from a caller) and a `req_`
  shaped trace id; the record moved `pending -> running -> completed` and the snapshot counted it.

  **3. An idempotency key is honoured.** Two enqueues with the same key returned the first job,
  the second with `deduplicated: true`, and the payload of the second enqueue did not replace the
  first. A job without a key never deduplicates.

  **4. A claim is a lease.** Reserving set `status: "running"`, `attempt: 1` and
  `leaseExpiresAtEpochMs = now + leaseDurationMs`; a reserve before the job's `availableAt`
  returned `null`; after the lease expired, `releaseExpiredLeases` returned the job to the queue
  with `attempt: 2` and `lastErrorCode: "LEASE_EXPIRED"`, so the attempt counter survives a stall.

  **5. Retry and death follow the catalog.** `TIMEOUT` (retryable) produced `retrying` with
  `availableAtEpochMs = now + retryDelayMs(2)`, and the job was not claimable before that instant;
  `PERMISSION_DENIED` (not retryable) produced `failed` on the first attempt with a null
  availability. Backoff is `min(900s, 15s * 2^(attempt-1))`: 15s, 30s, 60s, and the ceiling at
  attempt 64.

  **6. A runaway handler is aborted, not waited for.** A handler with `timeoutMs: 20` that waited
  on its signal saw `signal.aborted === true`, the attempt was recorded as `TIMEOUT`, the job
  (with `maxAttempts: 1`) settled as `failed`, and `runOnce` returned, so the slot freed.

  **7. A bad payload never reaches a handler.** An invalid payload sent through `enqueueJob` threw
  before the store grew (`total` stayed 0); a payload already in the store that no longer matched
  the schema was settled as `failed` with `VALIDATION_FAILED` and no handler call. A job name that
  was never registered was settled as `failed` with `INTERNAL_ERROR` rather than retried forever.

  **8. A schedule runs once per slot.** Registering a schedule for an unregistered job threw
  `JobNotRegisteredError`; an interval below one second threw `RangeError`; a duplicate name threw
  `ScheduleAlreadyRegisteredError`. Two ticks inside one slot enqueued one job; the next slot
  enqueued another, and the two jobs were pending.

  **9. Health degrades for the three reasons it claims.** An expired lease produced
  `status: "degraded"`, `reasons: ["stalled_jobs"]`, `queue.stalled: 1`; a pending job older than
  `stalledAfterSeconds` produced `oldest_pending_job_too_old`; a job that died produced
  `failed_jobs` and `degraded`; and `healthStatus` answered `200` for the healthy snapshot and
  `503` for the degraded one, which is exactly what the route returns.

  **10. Nothing starts itself.** `getJobRuntime()` returned the same instance twice, with an empty
  registry, an empty scheduler and a worker whose `running` is `false`; `start()` is the only call
  that begins polling, and `stop()` clears the timer and waits for the claims in flight.

  **11. The gate.** `npm run check:jobs` reports
  `jobs gate passed: 110 checks, 4 worker slots, 5 default attempts, store "memory"`. It drives
  the real registry, queue, worker and scheduler on an injected clock, with a silent logger, so it
  asserts stored records rather than log text.

  **12. The gate fails closed.** Five deliberate regressions, each applied, run and reverted:
  - `job.attempt < job.maxAttempts` changed to `<=` ->
    `a timed out handler must fail its last attempt (expected "failed", received "retrying")`;
  - a duplicate enqueue returning `deduplicated: false` ->
    `a repeated idempotency key must be deduplicated`;
  - every catalog code treated as retryable ->
    `a non-retryable catalog code must fail on the first attempt (expected 1, received 0)`;
  - the scheduler slot guard weakened from `slot <= lastSlot` to `slot < lastSlot` ->
    `a second tick in the same slot must enqueue nothing (expected 0, received 1)`;
  - the `failed_jobs` rule disabled -> `a dead job must name its rule`,
    `a dead job must degrade the snapshot (expected "degraded", received "ok")` and
    `a degraded snapshot must answer 503 (expected 503, received 200)`.
  Restoring each mutation returns the green line in item 11.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable, no
  surface changed. The shell from STEP 010 is untouched.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: the route
  has no input, no tenant and no authentication by design, because it is a probe. Success is
  item 1; the failure path is the `503` proven in items 9 and 12. `withErrorResponse` gives an
  unexpected store failure the STEP 008 envelope instead of a Next.js error page.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this STEP
  moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Lint result: pass, `npm run lint` exits 0 with the STEP 009 matrix; the gate's own null checks
  replaced three non-null assertions the lint rule refuses.
- Build result for the touched area: pass on Node.js 26.13.0. The route table is `○ /`,
  `○ /_not-found`, `ƒ /api/health`, `ƒ /api/jobs/health`; the production server answered as in
  item 1.
- `npm run verify` now runs ten gates plus typecheck, lint and build, and exits 0 in about 15
  seconds:
  `structure gate passed: 16 directories, 13 root files, 68 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 10 sections, 28 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 36 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`,
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`,
  `shell gate passed: 98 checks, 12 files scanned, no colour literal, no palette step, theme
  script and provider agree`,
  `jobs gate passed: 110 checks, 4 worker slots, 5 default attempts, store "memory"`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change.

## Next
- Next STEP number: STEP 012 - Database schema, migrations and generated types. Not started. This
  chat ends here as the owner asked, and STEP 012 needs the owner's consent.
- Anything the next chat must know:
  1. STEP 012 implements `JobQueue` over SQL. The port is `lib/jobs/queue.ts`: `enqueue`,
     `reserve` (with a lease), `complete`, `fail`, `releaseExpiredLeases`, `snapshot`, and the
     `store` name. The worker, the scheduler and the route must not change; if a method needs a
     new argument, that is a design change, not a migration detail.
  2. The in-memory store exists for development and the gate and says so (`store: "memory"`).
     The snapshot field is the only thing that tells an operator which one answered, so a SQL
     store must report its real name. `getJobRuntime()` swaps the store in one place.
  3. `enqueueJob` is the feature facing call. Direct `queue.enqueue` skips schema validation and
     the definition's attempt ceiling, which is how a job ends up retrying five times when its
     definition asked for two.
  4. The attempt counter must survive a lease expiry, and an expired lease must settle as
     `failed` at the ceiling rather than looping. The gate proves both in the memory store; the
     SQL store needs the same `attempt >= maxAttempts` branch, and `LEASE_EXPIRED` is the code.
  5. Retryability comes from `ERROR_CODES` in `lib/errors/codes.ts`. A job that wants a retry
     throws an `AppError` with a retryable code and does nothing else; a job that wants to stop
     throws `VALIDATION_FAILED` or `PERMISSION_DENIED`.
  6. A handler must honour `context.signal`; the worker aborts it at the definition's timeout and
     records `TIMEOUT`. A handler that ignores the signal keeps running after the record is
     settled, which the SQL store cannot fix.
  7. Nothing starts a worker or a scheduler at import time. A deployment STEP decides; the
     README lists this as rule 9 because a serverless platform would otherwise grow a worker per
     instance.
  8. The scheduler is an interval clock, not a cron parser. A calendar schedule would arrive with
     the deployment STEP that owns the clock, and its idempotency key must keep the slot index.
  9. `app/api/jobs/health` answers `503` when a job has died, by design. If an operator finds that
     too sharp, the rule is in `buildJobHealthSnapshot`, not in the route, and the gate asserts
     the mapping.
  10. Still open for their owners: migrations and the queue table (012), the durable store, the
      provider adapters (147-175), the email templates (221-230), the public navigation (231-238)
      and the deployment schedules (244-250).
