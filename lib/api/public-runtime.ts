// path: lib/api/public-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { PublicApiDependencies } from "./public-api.ts";

/**
 * The production wiring of section 20's public API: the service role client, the signed chain and a clock.
 *
 * The same projection `credential-runtime.ts` and `dispute-runtime.ts` make - one factory, one validated
 * environment - because a second construction of the REST client is how a route ends up reading rows with a
 * credential nobody checked.
 *
 * There is no encryption key here on purpose: authentication only ever hashes what arrived and compares it to a
 * stored hash, and a module that can open a signing secret is a module an injection bug can read secrets out of.
 */
export function getPublicApiRuntime(): PublicApiDependencies {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
