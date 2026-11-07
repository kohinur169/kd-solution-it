// path: services/disputes/chargeback-rate-job.ts
import { z } from "zod";
import type { JobContext, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobRegistry } from "../../lib/jobs/registry.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import {
  runChargebackSweep,
  type ChargebackRateDependencies,
  type ChargebackSweepResult,
} from "./chargeback-rate.ts";

/**
 * Section 18's chargeback clock, as a job.
 *
 * ## Why this is a sweep and not an event
 *
 * A chargeback rate is a ratio over a window, so nothing in a single row knows it. A dispute opening is not the
 * moment a merchant crosses a bar: the bar is crossed by the *window*, which moves every day while the numbers
 * stay still. This job is that moving window asking the rows once a day.
 *
 * ## What it may and may not do
 *
 * It takes the warning and the extra reserve, which are the platform's own acts, and it reports how many
 * merchants' numbers earn a suspension without taking one. `runChargebackSweep` is the same function the office's
 * "run now" panel calls, so there is exactly one implementation of "what step does this merchant earn" and one
 * place that could ever disagree with the watchlist.
 *
 * ## Why its payload may name one merchant
 *
 * `{ company_id }` is the shape the rest of this repository's sweeps use - one merchant per job, so a
 * deployment's scheduler decides which companies to tick and how often. `{}` is the platform-wide tick. Both are
 * the same handler and the same service, and both write each row under its own company.
 *
 * ## Why it is retried rather than run once
 *
 * `0128`'s unique index is the claim: a step that is already live for a merchant is refused by the database, so a
 * second run of the same day writes nothing twice. A run that died half way resumes the rest on the next attempt,
 * which is why the definition carries no `maxAttempts` and takes the registry's default.
 *
 * ## What it does not do
 *
 * It does not send an email: a warning hands a row to `email_send_logs`, and STEP 227's worker delivers it. It does
 * not move money: the extra reserve is a `0044` agreement, and withholding against it is that ledger's own act.
 */

/** The job's name. */
export const CHARGEBACK_MONITOR_JOB_NAME = "dispute.chargeback_rate";

/**
 * The payload: one merchant, or all of them.
 *
 * `.strict()`, so a dispatcher that tries to carry a rate, a threshold or an actor is refused at the call site
 * rather than storing a queue row whose extra field the handler would either trust or silently ignore.
 */
export const chargebackMonitorJobPayloadSchema = z
  .object({
    company_id: z.string().uuid().optional(),
  })
  .strict();

export type ChargebackMonitorJobPayload = z.infer<typeof chargebackMonitorJobPayloadSchema>;

/** The dependencies of the handler: the rate service's own, with the clock left to the worker. */
export type ChargebackMonitorJobDependencies = ChargebackRateDependencies;

/**
 * The handler's body, exported so the gate can drive the real handler against a fake `RestClient`, a fake chain
 * and a pinned clock - a handler that could only run against a live database is a handler nobody has executed.
 */
export async function runChargebackMonitorJob(
  payload: ChargebackMonitorJobPayload,
  dependencies: ChargebackMonitorJobDependencies,
): Promise<ChargebackSweepResult> {
  return runChargebackSweep({ companyId: payload.company_id ?? null }, dependencies);
}

/** The definition a scheduler registers. */
export function createChargebackMonitorJob(
  dependenciesOf: () => ChargebackMonitorJobDependencies,
): JobDefinition<ChargebackMonitorJobPayload> {
  return {
    name: CHARGEBACK_MONITOR_JOB_NAME,
    payloadSchema: chargebackMonitorJobPayloadSchema,
    handler: async (context: JobContext<ChargebackMonitorJobPayload>) => {
      await runChargebackMonitorJob(context.payload, dependenciesOf());
    },
  };
}

/** Register the job once: a process that boots twice does not die on the second registration. */
export function registerChargebackMonitorJob(
  registry: JobRegistry,
  dependenciesOf: () => ChargebackMonitorJobDependencies,
): void {
  if (registry.has(CHARGEBACK_MONITOR_JOB_NAME)) {
    return;
  }

  registry.register(createChargebackMonitorJob(dependenciesOf));
}

/** The default instance, closing over the auth runtime like every other job in this repository. */
export function createDefaultChargebackMonitorJob(): JobDefinition<ChargebackMonitorJobPayload> {
  return createChargebackMonitorJob(() => {
    const runtime = getAuthRuntime();

    return { rest: runtime.rest, audit: runtime.audit };
  });
}

/** The task name the sweep runs under, exported so a registration line and a gate agree on one spelling. */
export const CHARGEBACK_MONITOR_TASK = "chargeback.monitor";
