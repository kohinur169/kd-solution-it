// path: services/disputes/dispute-warnings-job.ts
import { z } from "zod";
import type { JobContext, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobRegistry } from "../../lib/jobs/registry.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { runDisputeWarningSweep, type DisputeWarningDependencies, type DisputeWarningSweepResult } from "./dispute-warnings.ts";

/**
 * The clock behind section 19's two warnings, as a job.
 *
 * ## Why a sweep, and why its payload may name a merchant
 *
 * Nothing in a dispute's own life knows when its middle arrives, so the warning at the midpoint cannot be an
 * event: it is time passing, which means a clock asking the rows. This job is that question. Its payload names
 * one company or none:
 *
 *   - `{ company_id }` is the shape the rest of this repository's sweeps use (`invoice.overdue_sweep`): one
 *     merchant per job, so a deployment's scheduler decides which companies to tick and how often, and no
 *     single job ever holds two merchants' data at once.
 *   - `{}` is the platform-wide tick, which is what a deployment with a real clock registers. It exists for
 *     the same reason the office queue reads every merchant: the warning is owed per merchant, but the
 *     question "which warnings are due now" can only be asked once. The sweep still writes each row under its
 *     own company and audits it there.
 *
 * Both are the same handler and the same service, so the two can never disagree about when the middle of a
 * window is.
 *
 * ## Why it is retried, not run once
 *
 * The claim is `0125`'s unique index, so a second run of the same slot sends nothing twice. A run that died
 * half way through a merchant's disputes resumes the rest on the next attempt instead of waiting a whole
 * interval, which is why the definition carries no `maxAttempts` and takes the registry's default.
 *
 * ## What it does not do
 *
 * It does not send anything. It hands rows to `email_send_logs`, which STEP 227's worker delivers; a platform
 * whose office has configured no sender writes nothing and reports `sender_not_configured`, and the tick after
 * the office configures one sends what is still due.
 */

/** The job's name. */
export const DISPUTE_WARNING_JOB_NAME = "dispute.deadline_warnings";

/**
 * The payload: one merchant, or all of them.
 *
 * `.strict()`, so a dispatcher that tries to carry a stage, a deadline or an address is refused at the call
 * site rather than storing a queue row whose extra field the handler would either trust or silently ignore.
 */
export const disputeWarningJobPayloadSchema = z
  .object({
    company_id: z.string().uuid().optional(),
  })
  .strict();

export type DisputeWarningJobPayload = z.infer<typeof disputeWarningJobPayloadSchema>;

/** The dependencies of the handler: the warning service's own, with the clock left to the worker. */
export type DisputeWarningJobDependencies = DisputeWarningDependencies;

/**
 * The handler's body, exported so the gate can drive the real handler against a fake `RestClient`, a fake
 * chain and a pinned clock - a handler that could only run against a live database is a handler nobody has
 * ever executed.
 */
export async function runDisputeWarningJob(
  payload: DisputeWarningJobPayload,
  dependencies: DisputeWarningJobDependencies,
): Promise<DisputeWarningSweepResult> {
  return runDisputeWarningSweep({ companyId: payload.company_id ?? null }, dependencies);
}

/** The definition a scheduler registers. */
export function createDisputeWarningJob(
  dependenciesOf: () => DisputeWarningJobDependencies,
): JobDefinition<DisputeWarningJobPayload> {
  return {
    name: DISPUTE_WARNING_JOB_NAME,
    payloadSchema: disputeWarningJobPayloadSchema,
    handler: async (context: JobContext<DisputeWarningJobPayload>) => {
      await runDisputeWarningJob(context.payload, dependenciesOf());
    },
  };
}

/** Register the job once: a process that boots twice does not die on the second registration. */
export function registerDisputeWarningJob(
  registry: JobRegistry,
  dependenciesOf: () => DisputeWarningJobDependencies,
): void {
  if (registry.has(DISPUTE_WARNING_JOB_NAME)) {
    return;
  }

  registry.register(createDisputeWarningJob(dependenciesOf));
}

/** The default instance, closing over the auth runtime like every other job in this repository. */
export function createDefaultDisputeWarningJob(): JobDefinition<DisputeWarningJobPayload> {
  return createDisputeWarningJob(() => {
    const runtime = getAuthRuntime();

    return { rest: runtime.rest, audit: runtime.audit };
  });
}
