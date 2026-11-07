// path: app/(client-portal)/portal-billing-match-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import {
  createInMemoryPaymentReviewQueue,
  noPortalCountryResolver,
} from "./portal-billing-match-processor.ts";
import type { PortalBillingMatchDependencies } from "./portal-billing-match.ts";

/**
 * The production wiring of section 18's billing match.
 *
 * ## What is real
 *
 * The read is: the client record the invoice was issued to, tenant scoped, two columns. The comparison is: one
 * function, in one file, over normalised values. The audit chain is the platform's signed one. None of those
 * needs a provider, which is why the rule is fully implemented rather than promised.
 *
 * ## What is not, and who owns it
 *
 *   - **A country for an address.** This deployment has no geolocation data; the runtime binds
 *     `noPortalCountryResolver`, so `ipCountryMatched` is always false and the fallback capture of section 18's
 *     second sentence cannot fire. A deployment with a resolver changes one line here.
 *   - **A durable review queue.** The destination exists in `0037_payments.sql` (`under_review`,
 *     `risk_decision = 'review'`, an index on the status), and the row belongs to STEP 130/132's payment
 *     operation. Until that operation routes reviews, the queue here is in memory and reports every routing as
 *     refused; the decision not to capture is made in the caller and does not depend on it.
 *
 * ## Why a function and not a constant
 *
 * A constant would read the environment at import time and make a gate that imports this module need a runtime
 * secret. It is built on first use and kept, exactly as the other portal runtimes are.
 */

export type PortalBillingMatchRuntime = PortalBillingMatchDependencies;

let runtime: PortalBillingMatchRuntime | undefined;

export function getPortalBillingMatchRuntime(): PortalBillingMatchRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();

  runtime = {
    rest: auth.rest,
    audit: auth.audit,
    resolver: noPortalCountryResolver,
    queue: createInMemoryPaymentReviewQueue(),
  };

  return runtime;
}
