// path: services/invoices/recurring-schedule-job.ts
import { z } from "zod";
import type { JobContext, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobRegistry } from "../../lib/jobs/registry.ts";
import { RECURRING_SCHEDULE_JOB_NAME } from "./recurring-schedule-fields.ts";

/**
 * The contract of section 27's recurring invoice job, which STEP 123 implements.
 *
 * ## Why this file exists in STEP 122 at all
 *
 * `FEATURE_LIST` names three things in one breath - "Recurring invoices exist", the run, and the reminders -
 * and `STEP_PLAN_250` splits them across two entries: STEP 122 configures a schedule, STEP 123 generates the
 * invoices and sends the reminders. The join between the two is a job payload, and a payload is a contract:
 * whoever implements the handler cannot invent its fields, because a schedule that has already been paused or
 * edited by the time the job runs must be re-read rather than trusted from a queue row.
 *
 * So STEP 122 states the contract and registers nothing. That is deliberate and it is the honest split: a
 * `registerJob` here would need a handler, the handler is the generator, and writing a placeholder that
 * returns would put a job in the registry that silently invoices nobody - the worst possible failure for a
 * billing system, because it looks like a working one. `verify.ts` asserts that this module registers nothing
 * and that the name it declares is the name STEP 123 may register.
 *
 * ## The payload is a pointer, not a copy
 *
 * The job names one schedule and one run date. It does not carry the interval, the template, the terms or the
 * reminder policy, because a queue row can sit for minutes before a worker claims it and a merchant can pause
 * the schedule in that time. Everything the run depends on is read from the row when the handler starts, and
 * `scheduleId` is the only thing that has to be true for the work to be meaningful.
 *
 * `runOn` is the date the run was *due*, not the date the worker happened to start. A job that was delayed by
 * a deploy still invoices the period it was for, and the generated invoice's due date is measured from that
 * date rather than from the delay - which is why it travels in the payload rather than being read from a clock.
 */

/** The job's name. STEP 123 registers a handler under exactly this name. */
export const RECURRING_SCHEDULE_JOB = RECURRING_SCHEDULE_JOB_NAME;

/**
 * The payload: which schedule, and which run date it is being run for.
 *
 * `.strict()`, so a dispatcher that tries to carry a second fact - a template, an amount, a client - is refused
 * at the call site rather than storing a queue row whose extra fields half the handlers would ignore and the
 * other half would trust.
 */
export const recurringScheduleJobPayloadSchema = z
  .object({
    schedule_id: z.string().uuid(),
    /** A calendar date, `YYYY-MM-DD`: the run this job is for, not the day it happens to execute. */
    run_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict();

export type RecurringScheduleJobPayload = z.infer<typeof recurringScheduleJobPayloadSchema>;

/**
 * What the handler of STEP 123 must answer with, so the two STEPs agree on the outcome's shape.
 *
 * This is a documented interface rather than a value: nothing here is executed. A generation either produces
 * an invoice, is skipped because the schedule is no longer due or has ended, or is refused because the
 * template is no longer a draft - and the three outcomes are different facts a health report should show
 * separately rather than as "the job ran".
 */
export interface RecurringScheduleJobOutcome {
  readonly scheduleId: string;
  readonly runOn: string;
  readonly kind: "generated" | "skipped" | "refused";
  /** The invoice this run produced, when it produced one. */
  readonly invoiceId: string | null;
  /** Why a run did nothing: `paused`, `ended`, `not_due`, `template_not_draft`. */
  readonly reason: string | null;
}

/**
 * The definition STEP 123 fills in.
 *
 * Declared here as a type so the payload cannot drift from the handler, and deliberately not instantiated.
 * `maxAttempts` is one: section 16 says a failed recurring payment is never retried automatically, and the
 * same rule applies to the generation that leads to it - a run that failed is a run the merchant sees as
 * missing, and re-running it silently would invoice a client twice if the first attempt had actually written
 * before the worker died.
 */
export type RecurringScheduleJobDefinition = JobDefinition<RecurringScheduleJobPayload> & {
  readonly name: typeof RECURRING_SCHEDULE_JOB;
  readonly maxAttempts: 1;
};

/**
 * Register the generator, once STEP 123 has a handler to register.
 *
 * This function exists so the STEP boundary is a named seam rather than a comment: STEP 123 calls it with its
 * handler and the name and payload are already fixed. Nothing calls it today, and `verify.ts` asserts that -
 * a registered job with no handler would be a queue that accepts work nobody does.
 */
export function registerRecurringScheduleJob(
  registry: JobRegistry,
  handler: (context: JobContext<RecurringScheduleJobPayload>) => Promise<void>,
): void {
  if (registry.has(RECURRING_SCHEDULE_JOB)) {
    return;
  }

  registry.register({
    name: RECURRING_SCHEDULE_JOB,
    payloadSchema: recurringScheduleJobPayloadSchema,
    handler,
    maxAttempts: 1,
  });
}
