// path: lib/approvals/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { ApprovalDependencies } from "./service.ts";

/**
 * The production wiring of the approval queue: the PostgREST client, the signed audit trail and the
 * clock.
 *
 * ## Why this is its own module
 *
 * The CEO home and the request route both need the same three dependencies, and a second copy of them
 * is how one of the two ends up writing to the queue without an audit entry. `getAuthRuntime()`
 * already validates the environment, builds the service role client and the Ed25519 signing trail, so
 * this module is a projection of it rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * There is no sealer and no provider here: an approval request stores no secret. It stores a decision
 * about a subject, and the only protected thing it touches is the permission to raise it, which lives
 * in `lib/approvals/service.ts` beside the write.
 */

/** The dependencies the CEO home and the request route use. */
export type ApprovalRuntime = ApprovalDependencies & { readonly now: () => number };

export function getApprovalRuntime(): ApprovalRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
