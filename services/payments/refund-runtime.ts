// path: services/payments/refund-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { RefundDependencies } from "./refund.ts";

/**
 * The production wiring of section 19's refund: the PostgREST client, the signed audit trail and a clock.
 *
 * ## Why this is a module and not three lines in each route
 *
 * Five routes read and write refunds - the merchant's request, cancel, list and payment list, and the
 * platform's queue and decision - and four copies of a dependency object is how one of them ends up
 * writing a row without a chain entry. `getAuthRuntime()` already validates the environment, builds the
 * service role client and the Ed25519 signing trail, so this module is a projection of it rather than a
 * second factory.
 *
 * ## What is deliberately absent
 *
 * No provider, no sealer and no key ring. A refund request moves no money: it is a row a person raised
 * and, later, a person decided. STEP 192 adds the processor to the act that executes, and it will add it
 * here rather than to a second runtime.
 */

/** The dependencies the five refund routes use. */
export type RefundRuntime = RefundDependencies & { readonly now: () => number };

export function getRefundRuntime(): RefundRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
