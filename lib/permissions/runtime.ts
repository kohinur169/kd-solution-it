// path: lib/permissions/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { PermissionDependencies } from "./service.ts";

/**
 * The production wiring of the delegation screen: the PostgREST client, the signed audit trail and the
 * clock.
 *
 * ## Why this is its own module
 *
 * The page and the route both need the same three dependencies, and a second copy of them is how one of
 * the two ends up writing a grant without an audit entry. `getAuthRuntime()` already validates the
 * environment, builds the service role client and the Ed25519 signing trail, so this is a projection of
 * it rather than a second factory - the same shape `lib/approvals/runtime.ts` uses for the CEO home.
 *
 * ## What is deliberately absent
 *
 * There is no sealer here: a delegation records an authority, not a secret. What it does not contain is
 * as important - the service role key never leaves `getAuthRuntime`, and the page reaches the tables
 * only through `lib/permissions/service.ts`, whose first statement is the role check.
 */

/** The dependencies the delegation page and route use. */
export type PermissionRuntime = PermissionDependencies & { readonly now: () => number };

export function getPermissionRuntime(): PermissionRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
