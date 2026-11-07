// path: services/billing/plans-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { PlanDependencies } from "./plans.ts";

/**
 * The production wiring of the plan catalogue: the PostgREST client, the signed audit trail and the
 * clock.
 *
 * ## Why this is its own module
 *
 * The office screen and the route that creates a plan must reach the same three dependencies, and a
 * second copy of them is how one of the two ends up writing a plan without a chain entry. The
 * authentication block already validated the environment and built the service role client and the
 * signing trail, so this module is a projection of it rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * No sealer, no provider and no queue: a plan row holds a code, a name, a price and a period, and
 * the only protected thing this STEP touches is the permission to create one, which lives in
 * `plans.ts` beside the write.
 */

/** The dependencies the screen and the route use. */
export type PlanRuntime = PlanDependencies;

/** The dependencies the screen and the route use. */
export function getPlanRuntime(): PlanRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
