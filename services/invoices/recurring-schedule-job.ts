// path: services/invoices/recurring-schedule-job.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { JobContext, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobRegistry } from "../../lib/jobs/registry.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { RECURRING_SCHEDULE_JOB_NAME } from "./recurring-schedule-fields.ts";
import {
  generateRecurringInvoice,
  sweepRecurringReminders,
  type RecurringGenerationResult,
} from "./recurring-generation.ts";

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

/* ---------------------------------------------------------------------------------------------------------
 * STEP 123: the handler the contract above was written for.
 *
 * The split the two STEPs agreed on is kept exactly: the payload, the outcome shape, the attempt ceiling and the
 * registration seam above are STEP 122's and are untouched. What is added here is the body that does the work,
 * wired the way every other job in this repository is wired - a factory that takes its dependencies, and one
 * default instance that closes over the auth runtime so a route or a scheduler can register it without passing
 * anything.
 *
 * `createRecurringGenerationJob` exists so the gate can drive the real handler against a fake `RestClient` and a
 * fake clock. A handler that could only run against a live database would be a handler nobody had ever executed,
 * and the whole point of this STEP is that a repeated run must not double-bill a client.
 * ------------------------------------------------------------------------------------------------------- */

/**
 * What the handler needs to run: the storage client, the audit trail and the calendar.
 *
 * `today` is injected rather than read from `Date` inside the handler, for the same reason every date in this
 * family is injected: a gate has to be able to say "it is the fifth of November" and get the same answer in
 * 2032. The scheduler that enqueues the work decides which day it is enqueuing for; the worker merely runs it.
 */
export interface RecurringScheduleJobDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** The calendar day the run is being evaluated on, `YYYY-MM-DD`. */
  readonly today: () => string;
}

/** The default handler wiring: the process's own storage and audit trail. */
function defaultRecurringGenerationJob(
  dependenciesOf: () => RecurringScheduleJobDependencies,
): JobDefinition<RecurringScheduleJobPayload> {
  return {
    name: RECURRING_SCHEDULE_JOB,
    payloadSchema: recurringScheduleJobPayloadSchema,
    maxAttempts: 1,
    handler: async (context) => {
      await runRecurringScheduleJob(context.payload, dependenciesOf());
    },
  };
}

/**
 * The handler's body: one occurrence of one schedule, then the reminders its invoices earned.
 *
 * The order is deliberate. Generation happens first, because a reminder is about an invoice that exists; the
 * sweep runs second and only over invoices that were already issued, so a generated draft is left alone - see
 * `RECURRING_REMINDER_STATUSES` for why a document nobody has received cannot be late.
 *
 * A skipped generation is not a failure and does not raise: the queue delivered a run for a schedule a merchant
 * paused, or one another worker already filled. The outcome is logged through the job's own return value rather
 * than an exception, so `maxAttempts: 1` is not spent on a run that had nothing to do.
 */
export async function runRecurringScheduleJob(
  payload: RecurringScheduleJobPayload,
  dependencies: RecurringScheduleJobDependencies,
): Promise<RecurringGenerationResult> {
  const result = await generateRecurringInvoice(
    { scheduleId: payload.schedule_id, runOn: payload.run_on },
    { rest: dependencies.rest, audit: dependencies.audit },
  );

  // Reminders are swept for the schedule's own merchant only when this run actually produced an invoice, because
  // a sweep is a per-merchant question and there is nothing new to remind about otherwise. Each one schedules its
  // own sweep; doing it here would make an idle run quadratic in the merchant's backlog.
  if (result.kind === "generated") {
    const [schedule] = await dependencies.rest.select(
      "recurring_schedules",
      `select=company_id&id=eq.${result.scheduleId}`,
      z.object({ company_id: z.string().uuid() }),
    );

    if (schedule !== undefined) {
      await sweepRecurringReminders(
        { companyId: schedule.company_id, today: dependencies.today() },
        { rest: dependencies.rest, audit: dependencies.audit },
      );
    }
  }

  return result;
}

/**
 * Register the generator, once, under the name STEP 122 fixed.
 *
 * Unlike the seam above this function writes no registration: it hands the seam a real handler, which is what the
 * seam was written for. A second call is a no-op inside the seam itself, so a process that boots twice registers
 * once.
 */
export function registerRecurringGenerationJob(
  registry: JobRegistry,
  dependenciesOf: () => RecurringScheduleJobDependencies,
): void {
  registerRecurringScheduleJob(registry, async (context) => {
    await runRecurringScheduleJob(context.payload, dependenciesOf());
  });
}

/** The default instance, closing over the auth runtime like every other route in this repository. */
export function createDefaultRecurringGenerationJob(): JobDefinition<RecurringScheduleJobPayload> {
  return defaultRecurringGenerationJob(() => {
    const runtime = getAuthRuntime();

    return { rest: runtime.rest, audit: runtime.audit, today: currentCalendarDay };
  });
}

/**
 * Today, in UTC, as `YYYY-MM-DD`.
 *
 * UTC and not the server's local zone: schedules are stored as calendar dates, the database writes `date` without
 * a zone, and two workers in two regions must agree on which occurrence they are filling. A local-time "today"
 * would make a run at 23:30 in Dhaka and one at 00:30 in UTC disagree by a day about the same schedule.
 */
export function currentCalendarDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
