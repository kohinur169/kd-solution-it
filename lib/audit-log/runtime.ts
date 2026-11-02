// path: lib/audit-log/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { AuditLogDependencies } from "./service.ts";

/**
 * The production wiring of the audit log viewer: the PostgREST client and the clock.
 *
 * The viewer reads and it verifies, and both go through the same client the audit trail writes with -
 * the service role client of the authentication block, which `0074` lets read every chain. There is no
 * second factory here for the reason `lib/announcements/runtime.ts` gives: a second copy of the wiring
 * is how one call ends up running against a different client than the rest.
 *
 * The clock is per call, not per process, because the verification stamp the screen prints is the
 * instant of the press and not the instant the module happened to be loaded.
 */

/** The dependencies the screen uses. */
export type AuditLogRuntime = AuditLogDependencies & { readonly now: () => number };

/** The dependencies the screen uses. */
export function getAuditLogRuntime(): AuditLogRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    now: (): number => Date.now(),
  };
}
