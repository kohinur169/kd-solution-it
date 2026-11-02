// path: lib/countries/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { CountryDependencies } from "./service.ts";

/**
 * The production wiring of the country switch: the PostgREST client, the signed audit trail and the
 * clock.
 *
 * ## Why this is its own module
 *
 * The switch screen and the route that turns it must reach the same three dependencies, and a second
 * copy of them is how one of the two ends up flipping a country without an audit entry. The
 * authentication block already validates the environment and builds the service role client and the
 * Ed25519 signing trail, so this module is a projection of it rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * There is no sealer here and no provider: a country row holds a name, two codes and two booleans, and
 * the only protected thing the switch touches is the permission to turn it, which lives in
 * `lib/countries/service.ts` beside the write.
 */

/** The dependencies the screen and the route use. */
export type CountryRuntime = CountryDependencies & { readonly now: () => number };

/** The dependencies the screen and the route use. */
export function getCountryRuntime(): CountryRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
