// path: lib/announcements/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { AnnouncementDependencies } from "./service.ts";

/**
 * The production wiring of the announcements: the PostgREST client, the signed audit trail and the
 * clock.
 *
 * The composer screen, the composer route and the popup all need the same three dependencies, and a
 * second copy of them is how one of the three ends up writing without an audit entry. The
 * authentication block already validates the environment and builds the service role client and the
 * Ed25519 signing trail, so this module is a projection of it rather than a second factory.
 *
 * Nothing here is cached across requests: a runtime built once per call reads the clock per call,
 * which is what an announcement's publish and expiry instants depend on.
 */

/** The dependencies the composer, its route and the popup use. */
export type AnnouncementsRuntime = AnnouncementDependencies & { readonly now: () => number };

/** The dependencies the composer, its route and the popup use. */
export function getAnnouncementsRuntime(): AnnouncementsRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
