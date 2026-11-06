// path: services/invoices/overdue-sweep-job.ts
import { z } from "zod";
import type { JobContext, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobRegistry } from "../../lib/jobs/registry.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import {
  sweepOverdueInvoices,
  type InvoiceStatusDependencies,
  type OverdueSweepResult,
} from "./invoice-status.ts";

/**
 * The job of STEP 123's other half: the one that moves a company's past-due documents to `overdue`.
 *
 * ## Why a job, and why per company
 *
 * Section 16 names `overdue` as a state and `0022` builds `invoices_due_idx` for the sweep that finds due
 * documents, but a state nobody writes is a state that never happens - an invoice sat in `sent` forever and
 * a reminder recorded against it was the only trace that time had passed. The sweep that finally writes the
 * state runs outside a request, on a clock a merchant does not hold, and the only query it performs is the
 * per-company one every other read in this repository is: a platform-wide "which merchants are past due"
 * would be the one query allowed to see two companies at once.
 *
 * The job therefore names one company in its payload, and the scheduler that decides which companies to
 * sweep, and how often, is deployment work - the same work that wires the recurring job to a clock.
 *
 * ## Why the payload carries no date
 *
 * The recurring job carries `run_on`, the run date, because the period being billed is a business fact that
 * must not change when a worker runs late. The sweep has no such fact: its question is "is this document
 * past due *now*", and "now" is the worker's own instant, measured against the due date that sits on the
 * row. A delayed sweep is still the same sweep - it marks what is past due when it runs - so the date
 * belongs to the clock, not to the queue row, and a payload that carried one would be a fact the handler
 * could only ignore.
 *
 * ## Why the job is retried, not run once
 *
 * The recurring job is `maxAttempts: 1`, because a run that failed might have written an invoice, and a
 * silent retry would bill a client twice. This sweep has no such hazard: its move is guarded on the status
 * it read, so a run that marked a document is a no-op on the second run - the document is `overdue`, and
 * `overdue` is not a status the sweep reads. The status is the dedupe, which is what the default attempt
 * ceiling buys: a run that died mid-way on a flaky connection resumes its remaining work instead of waiting
 * for a whole day.
 */

/** The job's name. */
export const OVERDUE_SWEEP_JOB_NAME = "invoice.overdue_sweep";

/**
 * The payload: which company the sweep runs for.
 *
 * `.strict()`, so a dispatcher that tries to carry a second fact - a date, a status list, a limit - is
 * refused at the call site rather than storing a queue row whose extra fields the handler would trust or
 * ignore at the wrong moment.
 */
export const overdueSweepJobPayloadSchema = z
  .object({
    company_id: z.string().uuid(),
  })
  .strict();

export type OverdueSweepJobPayload = z.infer<typeof overdueSweepJobPayloadSchema>;

/**
 * The dependencies of the handler: the sweep's own, with the clock left to the worker.
 *
 * A `now` is injected here only by the gate; a registered handler reads the real clock, because the sweep's
 * instant is its only business fact and there is no run date to carry instead.
 */
export type OverdueSweepJobDependencies = InvoiceStatusDependencies;

/**
 * The handler's body: one company's overdue sweep, at the worker's own instant.
 *
 * Exported separately from the definition so the gate can drive the real handler against a fake
 * `RestClient`, a fake audit trail and a fake clock - a handler that could only run against a live database
 * would be a handler nobody had ever executed, and the whole point of this STEP is that a sweep may run
 * twice without writing a state twice.
 */
export async function runOverdueSweepJob(
  payload: OverdueSweepJobPayload,
  dependencies: OverdueSweepJobDependencies,
): Promise<OverdueSweepResult> {
  return sweepOverdueInvoices({ companyId: payload.company_id }, dependencies);
}

/**
 * The definition a scheduler registers.
 *
 * The dependencies are a thunk, resolved when the handler runs, so a default instance may be created before
 * the auth runtime has booted - the same reason the recurring job's default is a thunk. `maxAttempts` is
 * deliberately absent, which makes the registry take its default: the sweep is idempotent through its own
 * guard, and a retry is the recovery a flaky connection deserves.
 */
export function createOverdueSweepJob(
  dependenciesOf: () => OverdueSweepJobDependencies,
): JobDefinition<OverdueSweepJobPayload> {
  return {
    name: OVERDUE_SWEEP_JOB_NAME,
    payloadSchema: overdueSweepJobPayloadSchema,
    handler: async (context: JobContext<OverdueSweepJobPayload>) => {
      await runOverdueSweepJob(context.payload, dependenciesOf());
    },
  };
}

/**
 * Register the sweep, once.
 *
 * A second call is a no-op: the registry refuses a duplicated name, and the guard here keeps a process
 * that boots twice from dying on the boot rather than on the registration.
 */
export function registerOverdueSweepJob(
  registry: JobRegistry,
  dependenciesOf: () => OverdueSweepJobDependencies,
): void {
  if (registry.has(OVERDUE_SWEEP_JOB_NAME)) {
    return;
  }

  registry.register(createOverdueSweepJob(dependenciesOf));
}

/** The default instance, closing over the auth runtime like every other job in this repository. */
export function createDefaultOverdueSweepJob(): JobDefinition<OverdueSweepJobPayload> {
  return createOverdueSweepJob(() => {
    const runtime = getAuthRuntime();

    return { rest: runtime.rest, audit: runtime.audit };
  });
}
