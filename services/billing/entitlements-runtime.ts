// path: services/billing/entitlements-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { createEntitlementReader, type EntitlementGuardDependencies, type EntitlementReader } from "./entitlements.ts";

/**
 * The production wiring of the entitlement authority: the PostgREST client, the signed audit trail, the
 * clock, and one reader per process.
 *
 * ## Why a reader and not three exports
 *
 * A request that checks six features should read the merchant's plan once. `createEntitlementReader` caches
 * one answer per merchant, and this module hands the same reader to every caller in the process so that a
 * page which checks three features in three modules still costs three queries rather than nine.
 *
 * ## Why the cache is process-wide here and request-wide by contract
 *
 * The cache keeps no timer and no invalidation: the platform's own writes to `subscriptions` belong to
 * STEP 214 and `plan_entitlements` to STEP 212, and neither can change inside the milliseconds of one
 * request. A long-lived process that cached for longer than a request would be answering from a snapshot a
 * super administrator may already have changed, so the contract the handoff states is that a caller reads
 * through this reader for the length of one request and no longer.
 *
 * ## What is deliberately absent
 *
 * No sealer and no provider: an entitlement is three reads of the platform's own tables, and the only
 * secret this module touches is the service role the authentication block already holds.
 */

let runtime: EntitlementReader | undefined;

/** The reader every merchant-feature check should use. */
export function getEntitlementReader(): EntitlementReader {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();

  runtime = createEntitlementReader({
    store: auth.rest,
    audit: auth.audit,
    now: (): number => Date.now(),
  });

  return runtime;
}

/** The three dependencies, for a caller that needs the raw reads rather than the cached reader. */
export function getEntitlementDependencies(): EntitlementGuardDependencies {
  const auth = getAuthRuntime();

  return {
    store: auth.rest,
    audit: auth.audit,
    now: (): number => Date.now(),
  };
}
